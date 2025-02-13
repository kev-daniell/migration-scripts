
import { Transform } from 'jscodeshift';

const transform: Transform = (file, api) => {
  const j = api.jscodeshift;
  const root = j(file.source);

  // Remove mocha/should imports
  root
    .find(j.ImportDeclaration)
    .filter(path => 
      path.node.source.value === 'should' ||
      path.node.source.value === 'mocha'
    )
    .remove();

  // Add node:test and node:assert imports if needed
  const hasNodeTest = root
    .find(j.ImportDeclaration)
    .filter(path => path.node.source.value === 'node:test')
    .length > 0;

  const hasNodeAssert = root
    .find(j.ImportDeclaration)
    .filter(path => path.node.source.value === 'node:assert')
    .length > 0;

  // Detect which test functions are used in the file
  const usedTestFunctions = new Set(['describe', 'it']);
  
  root
    .find(j.Identifier)
    .forEach(path => {
      const name = path.node.name;
      if (['before', 'after', 'beforeEach', 'afterEach'].includes(name)) {
        usedTestFunctions.add(name);
      }
    });

  if (!hasNodeTest) {
    root
      .find(j.Program)
      .get('body', 0)
      .insertBefore(
        j.importDeclaration(
          Array.from(usedTestFunctions).sort().map(name =>
            j.importSpecifier(j.identifier(name), j.identifier(name))
          ),
          j.literal('node:test')
        )
      );
  }

  // Only add assert import if no existing assert import exists
  const hasAnyAssertImport = root
    .find(j.ImportDeclaration)
    .filter(path => 
      path.node.source.value === 'node:assert' ||
      path.node.source.value === 'assert'
    )
    .length > 0;

  if (!hasAnyAssertImport) {
    root
      .find(j.Program)
      .get('body', 0)
      .insertBefore(
        j.importDeclaration(
          [j.importDefaultSpecifier(j.identifier('assert'))],
          j.literal('node:assert')
        )
      );
  }

  // Replace should assertions and their variations
  root
    .find(j.MemberExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      
      // Handle x.should.be.true(), x.should.be.false()
      if (j.MemberExpression.check(callee.object) &&
          j.Identifier.check(callee.object.property) &&
          callee.object.property.name === 'be') {
        return ['true', 'false'].includes(callee.property.name);
      }

      // Handle basic should assertions
      return j.Identifier.check(callee.property) && callee.property.name === 'should';
    })
    .forEach(path => {
      const callee = path.node.callee;
      if (j.MemberExpression.check(callee.object) &&
          j.Identifier.check(callee.object.property) &&
          callee.object.property.name === 'be') {
        // Handle x.should.be.true() -> assert.strictEqual(x, true)
        // and x.should.be.false() -> assert.strictEqual(x, false)
        const originalObject = callee.object.object.object;
        const booleanValue = callee.property.name === 'true';
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('strictEqual')),
            [originalObject, j.literal(booleanValue)]
          )
        );
      } else {
        // Handle basic should assertions
        const parentObject = path.node.callee.object;
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [parentObject]
          )
        );
      }
    });

  // Replace should.equal and x.should.equal
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (callee.property.name !== 'equal') return false;

      // Handle should.equal(x, y)
      if (j.Identifier.check(callee.object) && callee.object.name === 'should') {
        return true;
      }

      // Handle x.should.equal(y) and x.should.not.equal(y)
      if (j.MemberExpression.check(callee.object)) {
        // Case 1: x.should.equal(y)
        if (j.Identifier.check(callee.object.property) && 
            callee.object.property.name === 'should') {
          return true;
        }
        
        // Case 2: x.should.not.equal(y)
        if (j.Identifier.check(callee.object.property) && 
            callee.object.property.name === 'not' &&
            j.MemberExpression.check(callee.object.object) &&
            j.Identifier.check(callee.object.object.property) &&
            callee.object.object.property.name === 'should') {
          return true;
        }
      }

      return false;
    })
    .forEach(path => {
      const callee = path.node.callee;
      let firstArg;
      let isNegated = false;
      
      if (j.Identifier.check(callee.object) && callee.object.name === 'should') {
        // For should.equal(x, y) case
        firstArg = path.node.arguments[0];
      } else {
        // For x.should.equal(y) or x.should.not.equal(y) case
        if (j.MemberExpression.check(callee.object) && 
            j.Identifier.check(callee.object.property)) {
          if (callee.object.property.name === 'should') {
            // This is the x.should.equal(y) case
            firstArg = callee.object.object;
          } else if (callee.object.property.name === 'not') {
            // This is the x.should.not.equal(y) case
            firstArg = callee.object.object.object;
            isNegated = true;
          }
        }
      }

      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(
            j.identifier('assert'), 
            j.identifier(isNegated ? 'notEqual' : 'equal')
          ),
          [firstArg, ...path.node.arguments.slice(firstArg === path.node.arguments[0] ? 1 : 0)]
        )
      );
    });

  // Replace should.deepEqual and x.should.deepEqual
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (!['deepEqual', 'eql'].includes(callee.property.name)) return false;

      // Handle should.deepEqual(x, y) or should.eql(x, y)
      if (j.Identifier.check(callee.object) && callee.object.name === 'should') {
        return true;
      }

      // Handle x.should.deepEqual(y) or x.should.eql(y)
      if (j.MemberExpression.check(callee.object) &&
          j.Identifier.check(callee.object.property) &&
          callee.object.property.name === 'should') {
        return true;
      }

      return false;
    })
    .forEach(path => {
      const callee = path.node.callee;
      let firstArg;
      
      if (j.Identifier.check(callee.object) && callee.object.name === 'should') {
        // For should.deepEqual(x, y) or should.eql(x, y) case
        firstArg = path.node.arguments[0];
      } else {
        // For x.should.deepEqual(y) or x.should.eql(y) case
        firstArg = callee.object.object;
      }

      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(j.identifier('assert'), j.identifier('deepStrictEqual')),
          [firstArg, ...path.node.arguments.slice(firstArg === path.node.arguments[0] ? 1 : 0)]
        )
      );
    });

  // Replace x.should.be.true() and x.should.be.false() assertions
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (!['true', 'false'].includes(callee.property.name)) return false;

      // Check for x.should.be.true() or x.should.be.false()
      const object = callee.object;
      if (!j.MemberExpression.check(object)) return false;
      if (!j.Identifier.check(object.property)) return false;
      if (object.property.name !== 'be') return false;

      const shouldExpr = object.object;
      if (!j.MemberExpression.check(shouldExpr)) return false;
      if (!j.Identifier.check(shouldExpr.property)) return false;
      return shouldExpr.property.name === 'should';
    })
    .forEach(path => {
      const originalValue = path.node.callee.object.object.object;
      const booleanValue = path.node.callee.property.name === 'true';
      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(j.identifier('assert'), j.identifier('strictEqual')),
          [originalValue, j.literal(booleanValue)]
        )
      );
    });

  // Replace should assertions with specific patterns
  root
    .find(j.MemberExpression)
    .filter(path => {
      if (!path.node) return false;

      // Get the chain of properties
      const props = [];
      let current = path.node;
      while (j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property)) {
          props.unshift(current.property.name);
        }
        current = current.object;
      }

      // Check for .should
      return props.includes('should');
    })
    .forEach(path => {
      const props = [];
      let current = path.node;
      let originalValue = null;
      
      // Build the chain of properties and get original value
      while (j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property)) {
          props.unshift(current.property.name);
        }
        current = current.object;
      }
      originalValue = current;

      // Handle different assertion patterns
      if (props.includes('rejectedWith')) {
        // x.should.be.rejectedWith(msg) -> assert.rejects(x, { message: msg })
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('rejects')),
            [
              originalValue,
              j.objectExpression([
                j.property(
                  'init',
                  j.identifier('message'),
                  path.parent.node.arguments[0]
                )
              ])
            ]
          )
        );
      } else if (props.includes('fulfilled')) {
        // x.should.be.fulfilled -> assert.doesNotReject(() => x)
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('doesNotReject')),
            [
              j.arrowFunctionExpression(
                [],
                j.blockStatement([
                  j.returnStatement(originalValue)
                ])
              )
            ]
          )
        );
      } else if (props.includes('empty')) {
        // x.should.not.be.empty() -> assert.notEqual(x.length, 0)
        const isNegated = props.includes('not');
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier(isNegated ? 'notEqual' : 'equal')),
            [
              j.memberExpression(originalValue, j.identifier('length')),
              j.literal(0)
            ]
          )
        );
      } else if (props.includes('hasOwnProperty')) {
        // x.should.hasOwnProperty(y) -> assert.ok(Object.prototype.hasOwnProperty.call(x, y))
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [
              j.callExpression(
                j.memberExpression(
                  j.memberExpression(
                    j.memberExpression(
                      j.identifier('Object'),
                      j.identifier('prototype')
                    ),
                    j.identifier('hasOwnProperty')
                  ),
                  j.identifier('call')
                ),
                [originalValue, ...path.parent.node.arguments]
              )
            ]
          )
        );
      } else if (props.includes('greaterThanOrEqual')) {
        // x.should.greaterThanOrEqual(y) -> assert.ok(x >= y)
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [
              j.binaryExpression(
                '>=',
                originalValue,
                path.parent.node.arguments[0]
              )
            ]
          )
        );
      } else if (props.includes('instanceof')) {
        // x.should.be.an.instanceof(y) -> assert.ok(x instanceof y)
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [
              j.binaryExpression(
                'instanceof',
                originalValue,
                path.parent.node.arguments[0]
              )
            ]
          )
        );
      } else if (props.includes('property')) {
        // x.should.have.property(y) -> assert.ok(Object.prototype.hasOwnProperty.call(x, y))
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [
              j.callExpression(
                j.memberExpression(
                  j.memberExpression(
                    j.memberExpression(
                      j.identifier('Object'),
                      j.identifier('prototype')
                    ),
                    j.identifier('hasOwnProperty')
                  ),
                  j.identifier('call')
                ),
                [originalValue, ...path.parent.node.arguments]
              )
            ]
          )
        );
      }
    });

  // Replace should.exist and should.not.exist
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (callee.property.name !== 'exist') return false;

      const object = callee.object;
      // Handle should.exist(x)
      if (j.Identifier.check(object) && object.name === 'should') {
        return true;
      }
      // Handle should.not.exist(x)
      if (j.MemberExpression.check(object) &&
          j.Identifier.check(object.property) &&
          object.property.name === 'not' &&
          j.Identifier.check(object.object) &&
          object.object.name === 'should') {
        return true;
      }
      return false;
    })
    .forEach(path => {
      const callee = path.node.callee;
      const isNegated = j.MemberExpression.check(callee.object) &&
                       callee.object.property.name === 'not';
      
      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(
            j.identifier('assert'),
            j.identifier(isNegated ? 'equal' : 'ok')
          ),
          isNegated ? 
            [path.node.arguments[0], j.identifier('undefined')] :
            [path.node.arguments[0]]
        )
      );
    });

  // Replace should.doesNotThrow
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (callee.property.name !== 'doesNotThrow') return false;

      // Handle should.doesNotThrow(() => {...})
      if (j.Identifier.check(callee.object) && callee.object.name === 'should') {
        return true;
      }

      // Handle x.should.doesNotThrow
      if (j.MemberExpression.check(callee.object) &&
          j.Identifier.check(callee.object.property) &&
          callee.object.property.name === 'should') {
        return true;
      }

      return false;
    })
    .forEach(path => {
      const callee = path.node.callee;
      let fnArg;
      
      if (j.Identifier.check(callee.object) && callee.object.name === 'should') {
        // For should.doesNotThrow(() => {...}) case
        fnArg = path.node.arguments[0];
      } else {
        // For x.should.doesNotThrow case
        fnArg = callee.object.object;
      }

      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(j.identifier('assert'), j.identifier('doesNotThrow')),
          [fnArg]
        )
      );
    });

  // Replace should(x).equal(y) and should(x).ok()
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      
      // Check if it's a should(...) call
      const object = callee.object;
      if (!j.CallExpression.check(object)) return false;
      if (!j.Identifier.check(object.callee)) return false;
      if (object.callee.name !== 'should') return false;

      // Check for .equal() or .ok()
      if (!j.Identifier.check(callee.property)) return false;
      return ['equal', 'ok'].includes(callee.property.name);
    })
    .forEach(path => {
      const callee = path.node.callee;
      const shouldArg = callee.object.arguments[0];
      const methodName = callee.property.name;

      if (methodName === 'equal') {
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('strictEqual')),
            [shouldArg, ...path.node.arguments]
          )
        );
      } else if (methodName === 'ok') {
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [shouldArg]
          )
        );
      }
    });

  return root.toSource();
};

export default transform;