
import { Transform } from 'jscodeshift';

function ensureLodashImport(j: any, root: any): void {
  // Check if lodash is already imported
  const hasLodashImport = root
    .find(j.ImportDeclaration)
    .filter(path => 
      path.node.source.value === 'lodash' ||
      path.node.source.value === '_'
    )
    .length > 0;

  // Add lodash import if not present
  if (!hasLodashImport) {
    root
      .find(j.Program)
      .get('body', 0)
      .insertBefore(
        j.importDeclaration(
          [j.importDefaultSpecifier(j.identifier('_'))],
          j.literal('lodash')
        )
      );
  }
}

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

  // Add test and assert imports if needed
  const hasNodeTest = root
    .find(j.ImportDeclaration)
    .filter(path => path.node.source.value === 'node:test')
    .length > 0;

  const hasNodeAssert = root
    .find(j.ImportDeclaration)
    .filter(path => 
      path.node.source.value === 'node:assert' ||
      path.node.source.value === 'assert'
    )
    .length > 0;

  // Determine if file is in /modules/bitgo directory using relative path
  const isInBitGoModule = file.path.startsWith('modules/bitgo/') || file.path.includes('/modules/bitgo/');

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
        isInBitGoModule
          ? j.expressionStatement(
              j.assignmentExpression(
                '=',
                j.identifier('import assert'),
                j.callExpression(j.identifier('require'), [j.literal('assert')])
              )
            )
          : j.importDeclaration(
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

      // Handle x.should.equal(y), x.should.not.equal(y), and x.something.should.be.equal(y)
      if (j.MemberExpression.check(callee.object)) {
        let current = callee.object;
        const chain = [];
        while (j.MemberExpression.check(current)) {
          if (j.Identifier.check(current.property)) {
            chain.unshift(current.property.name);
          }
          current = current.object;
        }
        return chain.includes('should');
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
        // For x.should.equal(y), x.should.not.equal(y), or x.something.should.be.equal(y) case
        let current = callee.object;
        while (j.MemberExpression.check(current)) {
          if (j.Identifier.check(current.property)) {
            if (current.property.name === 'should') {
              firstArg = current.object;
              break;
            }
            if (current.property.name === 'not') {
              isNegated = true;
            }
          }
          current = current.object;
        }
      }

      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(
            j.identifier('assert'), 
            j.identifier(isNegated ? 'notStrictEqual' : 'strictEqual')
          ),
          [firstArg, ...path.node.arguments.slice(firstArg === path.node.arguments[0] ? 1 : 0)]
        )
      );
    });

  // Replace should.deepEqual and x.should.deepEqual (including negated versions)
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

      // Handle x.should.deepEqual(y), x.should.eql(y) and their negated versions
      if (j.MemberExpression.check(callee.object)) {
        let current = callee.object;
        while (j.MemberExpression.check(current)) {
          if (j.Identifier.check(current.property) && current.property.name === 'should') {
            return true;
          }
          current = current.object;
        }
      }

      return false;
    })
    .forEach(path => {
      const callee = path.node.callee;
      let firstArg;
      let isNegated = false;
      
      if (j.Identifier.check(callee.object) && callee.object.name === 'should') {
        // For should.deepEqual(x, y) or should.eql(x, y) case
        firstArg = path.node.arguments[0];
      } else {
        // For x.should.deepEqual(y) or x.should.not.deepEqual(y) case
        let current = callee.object;
        while (j.MemberExpression.check(current)) {
          if (j.Identifier.check(current.property)) {
            if (current.property.name === 'should') {
              firstArg = current.object;
              break;
            }
            if (current.property.name === 'not') {
              isNegated = true;
            }
          }
          current = current.object;
        }
      }

      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(
            j.identifier('assert'), 
            j.identifier(isNegated ? 'notDeepStrictEqual' : 'deepStrictEqual')
          ),
          [firstArg, ...path.node.arguments.slice(firstArg === path.node.arguments[0] ? 1 : 0)]
        )
      );
    });

  // Replace x.should.be.true(), x.should.be.false(), x.should.be.True(), x.should.be.False() assertions
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (!['true', 'false', 'True', 'False'].includes(callee.property.name)) return false;

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
      const booleanValue = path.node.callee.property.name.toLowerCase() === 'true';
      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(j.identifier('assert'), j.identifier('strictEqual')),
          [originalValue, j.literal(booleanValue)]
        )
      );
    });

  // Handle String() assertions
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (callee.property.name !== 'String') return false;

      // Check for .be.a.String() pattern
      let current = callee.object;
      while (j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property)) {
          if (current.property.name === 'should') return true;
        }
        current = current.object;
      }
      return false;
    })
    .forEach(path => {
      // Get the original value by walking up until we find .should
      let current = path.node.callee.object;
      let originalValue;
      while (current && j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property) && current.property.name === 'should') {
          originalValue = current.object;
          break;
        }
        current = current.object;
      }

      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(j.identifier('assert'), j.identifier('strictEqual')),
          [
            j.unaryExpression(
              'typeof',
              originalValue
            ),
            j.literal('string')
          ]
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
        // x.should.be.greaterThanOrEqual(y) -> assert.ok(x >= y)
        // Find the actual value by walking up the chain until we hit 'should'
        let current = path.node;
        while (j.MemberExpression.check(current)) {
          if (j.Identifier.check(current.property) && current.property.name === 'should') {
            originalValue = current.object;
            break;
          }
          current = current.object;
        }
        
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
      } else if (props.includes('within')) {
        // x.should.be.within(min, max) -> assert.ok(_.inRange(x, min, max))
        ensureLodashImport(j, root);
        // Get the actual value by walking up until we find .should
        let current = path.node;
        while (j.MemberExpression.check(current)) {
          if (j.Identifier.check(current.property) && current.property.name === 'should') {
            originalValue = current.object;
            break;
          }
          current = current.object;
        }
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [
              j.callExpression(
                j.memberExpression(j.identifier('_'), j.identifier('inRange')),
                [originalValue, ...path.parent.node.arguments]
              )
            ]
          )
        );
      } else if (props.includes('startWith')) {
        // x.should.startWith(y) -> assert.ok(_.startsWith(x, y))
        ensureLodashImport(j, root);
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [
              j.callExpression(
                j.memberExpression(j.identifier('_'), j.identifier('startsWith')),
                [originalValue, path.parent.node.arguments[0]]
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
      } else if (props.includes('propertyByPath')) {
        // x.should.have.propertyByPath('a','b').greaterThan(0)
        // -> assert.ok(_.get(x, ['a','b']) > 0)
        ensureLodashImport(j, root);
        const parent = path.parent;
        const grandParent = parent.parent;
        
        if (j.MemberExpression.check(grandParent.node) &&
            j.Identifier.check(grandParent.node.property) &&
            grandParent.node.property.name === 'greaterThan') {
          const greaterThanCall = grandParent.parent;
          if (j.CallExpression.check(greaterThanCall.node)) {
            j(greaterThanCall).replaceWith(
              j.callExpression(
                j.memberExpression(j.identifier('assert'), j.identifier('ok')),
                [
                  j.binaryExpression(
                    '>',
                    j.callExpression(
                      j.memberExpression(j.identifier('_'), j.identifier('get')),
                      [originalValue, j.arrayExpression(path.parent.node.arguments)]
                    ),
                    greaterThanCall.node.arguments[0]
                  )
                ]
              )
            );
            return;
          }
        }
        
        // x.should.have.propertyByPath('a','b') -> assert.ok(_.get(x, ['a','b']))
        j(path.parent).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [
              j.callExpression(
                j.memberExpression(j.identifier('_'), j.identifier('get')),
                [originalValue, j.arrayExpression(path.parent.node.arguments)]
              )
            ]
          )
        );
      } else if (props.includes('property')) {
        // x.should.have.property(y, z) -> assert.strictEqual(x[y], z)
        const args = path.parent.node.arguments;
        if (args.length === 2) {
          j(path.parent).replaceWith(
            j.callExpression(
              j.memberExpression(j.identifier('assert'), j.identifier('strictEqual')),
              [
                j.memberExpression(originalValue, args[0], true),
                args[1]
              ]
            )
          );
        } else {
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
                  [originalValue, ...args]
                )
              ]
            )
          );
        }
      }
    });

  // Handle throw assertions
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (!['throw', 'throwError'].includes(callee.property.name)) return false;

      // Check for should chain
      let current = callee.object;
      while (j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property)) {
          if (current.property.name === 'should') return true;
        }
        current = current.object;
      }
      return false;
    })
    .forEach(path => {
      // Check for negation
      let current = path.node.callee.object;
      let isNegated = false;
      let originalValue;
      
      while (current && j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property)) {
          if (current.property.name === 'not') {
            isNegated = true;
          }
          if (current.property.name === 'should') {
            originalValue = current.object;
            break;
          }
        }
        current = current.object;
      }

      // Get the function to test
      const fnToTest = originalValue || path.node.callee.object;
      
      // Get error message if provided
      const errorMessage = path.node.arguments[0];

      if (isNegated) {
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('doesNotThrow')),
            errorMessage ? [fnToTest, errorMessage] : [fnToTest]
          )
        );
      } else {
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('throws')),
            errorMessage ? [fnToTest, errorMessage] : [fnToTest]
          )
        );
      }
    });

  // Replace should(() => ...).throwError() pattern
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (callee.property.name !== 'throwError') return false;

      const object = callee.object;
      if (!j.CallExpression.check(object)) return false;
      if (!j.Identifier.check(object.callee)) return false;
      return object.callee.name === 'should';
    })
    .forEach(path => {
      // Get the error message
      const errorMessage = path.node.arguments[0];
      
      // Create new error message with TypeError prefix
      const newErrorMessage = j.literal(`TypeError: ${errorMessage.value}`);
      
      j(path).replaceWith(
        j.callExpression(
          j.memberExpression(j.identifier('assert'), j.identifier('throws')),
          [
            path.node.callee.object.arguments[0],
            newErrorMessage
          ]
        )
      );
    });

  // Replace x.should.have.properties() pattern
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      if (!j.MemberExpression.check(callee)) return false;
      if (!j.Identifier.check(callee.property)) return false;
      if (callee.property.name !== 'properties') return false;

      // Navigate up to check for .should.have
      let current = callee.object;
      while (j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property)) {
          if (current.property.name === 'should') return true;
        }
        current = current.object;
      }
      return false;
    })
    .forEach(path => {
      const obj = path.node.callee.object.object.object;
      const props = path.node.arguments[0];

      // Handle both array and object property lists
      if (j.ArrayExpression.check(props)) {
        // For array of strings: ['prop1', 'prop2']
        const propChecks = props.elements.map(prop => 
          j.callExpression(
            j.memberExpression(
              j.memberExpression(
                j.memberExpression(j.identifier('Object'), j.identifier('prototype')),
                j.identifier('hasOwnProperty')
              ),
              j.identifier('call')
            ),
            [obj, prop]
          )
        );

        const combinedCheck = propChecks.reduce((acc, check) => 
          j.logicalExpression('&&', acc, check)
        );

        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('ok')),
            [combinedCheck]
          )
        );
      } else {
        // For object: { prop1: value1, prop2: value2 }
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(j.identifier('assert'), j.identifier('deepStrictEqual')),
            [
              j.callExpression(
                j.memberExpression(
                  j.identifier('Object'),
                  j.identifier('fromEntries')
                ),
                [
                  j.callExpression(
                    j.memberExpression(
                      j.callExpression(
                        j.memberExpression(j.identifier('Object'), j.identifier('keys')),
                        [props]
                      ),
                      j.identifier('map')
                    ),
                    [
                      j.arrowFunctionExpression(
                        [j.identifier('key')],
                        j.arrayExpression([
                          j.identifier('key'),
                          j.memberExpression(obj, j.identifier('key'), true)
                        ])
                      )
                    ]
                  )
                ]
              ),
              props
            ]
          )
        );
      }
    });

  // Replace x.should.be.Null pattern
  root
    .find(j.MemberExpression, {
      property: { name: 'Null' }
    })
    .filter(path => {
      // Walk up the chain to find .should
      let current = path.node;
      while (current && j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property) && current.property.name === 'should') {
          return true;
        }
        current = current.object;
      }
      return false;
    })
    .forEach(path => {
      // Get the original value by walking up until we find .should
      let current = path.node;
      let originalValue;
      while (current && j.MemberExpression.check(current)) {
        if (j.Identifier.check(current.property) && current.property.name === 'should') {
          originalValue = current.object;
          break;
        }
        current = current.object;
      }

      // Check for .not in the chain
      let checkNode = path.node;
      let isNegated = false;
      while (checkNode && j.MemberExpression.check(checkNode)) {
        if (j.Identifier.check(checkNode.property) && checkNode.property.name === 'not') {
          isNegated = true;
          break;
        }
        checkNode = checkNode.object;
      }

      // Create the assertion
      const assertNode = j.callExpression(
        j.memberExpression(
          j.identifier('assert'),
          j.identifier(isNegated ? 'notStrictEqual' : 'strictEqual')
        ),
        [originalValue, j.literal(null)]
      );

      // Replace the entire chain
      let parent = path;
      while (parent.parent && j.MemberExpression.check(parent.parent.node)) {
        parent = parent.parent;
      }
      j(parent).replaceWith(assertNode);
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
