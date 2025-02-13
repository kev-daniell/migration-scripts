import { Transform, FileInfo, API, CallExpression, Identifier, StringLiteral, TSAsExpression } from 'jscodeshift';

interface StubReplacement {
  args?: any[];
  returnValue?: any;
}

const transform: Transform = (file: FileInfo, api: API) => {
  const j = api.jscodeshift;
  const root = j(file.source);

  // Check for sinon imports first
  const hasSinonImport = root
    .find(j.ImportDeclaration)
    .filter(path => path.node.source.value === 'sinon')
    .length > 0;

  // Only proceed with node:test import if we found and removed sinon
  if (hasSinonImport) {
    // Remove sinon imports
    root
      .find(j.ImportDeclaration)
      .filter(path => path.node.source.value === 'sinon')
      .remove();

    const nodeTestImports = root
      .find(j.ImportDeclaration)
      .filter(path => path.node.source.value === 'node:test');

    if (nodeTestImports.length === 0) {
      root
        .find(j.Program)
        .get('body', 0)
        .insertBefore(
          j.importDeclaration(
            [
              j.importSpecifier(j.identifier('mock'), j.identifier('mock')),
              j.importSpecifier(j.identifier('mocks'), j.identifier('mocks'))
            ],
            j.stringLiteral('node:test')
          )
        );
    } else {
      // Check if mocks is already in the imports
      nodeTestImports.forEach(path => {
        const hasMocks = path.node.specifiers.some(
          spec => j.ImportSpecifier.check(spec) && spec.imported.name === 'mocks'
        );
        
        if (!hasMocks) {
          // Add mocks to existing imports
          path.node.specifiers.push(
            j.importSpecifier(j.identifier('mock'), j.identifier('mock'))
          );
        }
      });
    }
  }

  // Replace sinon.createSandbox() with empty object since node:test doesn't need it
  root
    .find(j.VariableDeclaration)
    .filter(path => {
      const init = path.node.declarations[0].init;
      return (
        j.CallExpression.check(init) &&
        j.MemberExpression.check(init.callee) &&
        j.Identifier.check(init.callee.object) &&
        init.callee.object.name === 'sinon' &&
        j.Identifier.check(init.callee.property) &&
        init.callee.property.name === 'createSandbox'
      );
    })
    .remove();

  // Track stub chains and their replacements
  const stubChains = new Map<string, StubReplacement[]>();

  // First pass: collect all stub chains
  root
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { name: 'sandBox' },
        property: { name: 'stub' }
      }
    })
    .forEach(path => {
      const args = path.node.arguments;
      if (args.length < 2) return;

      const firstArg = args[0];
      const secondArg = args[1];
      
      // Get class and method names
      const className = firstArg.type === 'MemberExpression' && firstArg.object?.type === 'Identifier' 
        ? firstArg.object.name : null;
      
      let methodName;
      if (secondArg.type === 'StringLiteral' || secondArg.type === 'Literal') {
        methodName = secondArg.value;
      } else if (secondArg.type === 'Identifier') {
        methodName = secondArg.name;
      } else if (secondArg.type === 'TSAsExpression') {
        methodName = secondArg.expression.type === 'StringLiteral' 
          ? secondArg.expression.value
          : secondArg.expression.name;
      } else if (secondArg.type === 'MemberExpression') {
        methodName = secondArg.property.name;
      }


      if (!className || !methodName) {
        console.log('Warning: Could not extract class or method name', firstArg, secondArg);
        return;
      }

      // Find the parent test block to get the test name
      let testBlock = path;
      let testName = '';
      while (testBlock && testBlock.parent) {
        if (testBlock.node.type === 'CallExpression' && 
            testBlock.node.callee && 
            (testBlock.node.callee.name === 'it' || testBlock.node.callee.name === 'test')) {
          testName = testBlock.node.arguments[0].value;
          break;
        }
        testBlock = testBlock.parent;
      }

      const key = `${className}.${methodName}.${testName}`;
      console.log('CHECK stub chain:', key);
      if (stubChains.has(key)) {
        // Skip if we've already processed this test's stubs
        return;
      }
      const chains: StubReplacement[] = [];

      // Find the full chain of method calls after stub()
      let currentPath = path;
      
      // Get the parent VariableDeclarator
      let varDecPath = path.parent;
      while (varDecPath && varDecPath.node.type !== 'VariableDeclarator') {
        varDecPath = varDecPath.parent;
      }

      if (!varDecPath) return;

      // Get all the references to this variable
      const varName = varDecPath.node.id.name;
      const references = j(file.source)
        .find(j.CallExpression, {
          callee: {
            type: 'MemberExpression',
            object: {
              type: 'Identifier',
              name: varName
            }
          }
        });

      // Find all method calls on the stub variable
      const methodCalls = [];
      let currentRef = varDecPath;

      // Helper function to process a call chain
      const processCallChain = (startNode) => {
        let current = startNode;
        
        // Find the test block containing this chain
        let chainTestBlock = startNode;
        let chainTestName = '';
        while (chainTestBlock && chainTestBlock.parent) {
          if (chainTestBlock.node.type === 'CallExpression' && 
              chainTestBlock.node.callee && 
              (chainTestBlock.node.callee.name === 'it' || chainTestBlock.node.callee.name === 'test')) {
            chainTestName = chainTestBlock.node.arguments[0].value;
            break;
          }
          chainTestBlock = chainTestBlock.parent;
        }

        // Only process chains that are in the same test block
        if (chainTestName === testName) {
          while (current) {
            if (current.node.type === 'CallExpression') {
              methodCalls.push(current);
              // Look for chained calls in the parent
              if (current.parent?.node.type === 'MemberExpression' && 
                  current.parent.parent?.node.type === 'CallExpression') {
                current = current.parent.parent;
              } else {
                break;
              }
            } else {
              break;
            }
          }
        }
      };

      // First collect the immediate chained calls on the stub() call
      if (currentRef.parent) {
        processCallChain(currentRef.parent.parent);
      }

      // Then process any stored references and their chains
      references.forEach(refPath => {
        if (refPath.node.type === 'CallExpression') {
          // Start a new chain from this reference
          processCallChain(refPath);
        }
      });

      console.log('Collected method calls:', methodCalls.map(call => 
        call.node.callee.property?.name || 'unknown'
      ));

      // Group method calls by their chain
      const chainGroups = [];
      let currentChain = [];
      
      methodCalls.forEach(callPath => {
        const methodName = callPath.node.callee.property.name;
        currentChain.push({ methodName, callPath });
        
        // When we hit returns or resolves, that's the end of a chain
        if (methodName === 'returns' || methodName === 'resolves') {
          chainGroups.push([...currentChain]);
          currentChain = [];
        }
      });
      
      // Process each complete chain group
      chainGroups.forEach(group => {
        const chain: StubReplacement = {};
        
        group.forEach(({ methodName, callPath }) => {
          if (methodName === 'withArgs') {
            chain.args = callPath.node.arguments;
          } else if (methodName === 'returns') {
            chain.returnValue = callPath.node.arguments[0];
          } else if (methodName === 'resolves') {
            chain.returnValue = j.callExpression(
              j.memberExpression(
                j.identifier('Promise'),
                j.identifier('resolve')
              ),
              callPath.node.arguments
            );
          }
        });
        
        if (Object.keys(chain).length > 0) {
          chains.push(chain);
        }
      });


      if (chains.length > 0) {
        stubChains.set(key, chains);
      }
    });

  // Replace sandbox.stub() calls with mock.method()
  root
    .find(j.CallExpression)
    .filter(path => {
      const callee = path.node.callee;
      return (
        j.MemberExpression.check(callee) &&
        j.Identifier.check(callee.object) &&
        callee.object.name === 'sandBox' &&
        j.Identifier.check(callee.property) &&
        callee.property.name === 'stub'
      );
    })
    .forEach(path => {
      const args = path.node.arguments;
      if (args.length >= 2 && args[0].object) {
        const objName = args[0].object.name;
        // Handle different AST node types for method name
        let methodName;
        if (args[1].type === 'StringLiteral') {
          methodName = args[1].value;
        } else if (args[1].type === 'Identifier') {
          methodName = args[1].name;
        } else if (args[1].type === 'TSAsExpression') {
          methodName = args[1].expression.name || args[1].expression.value;
        }
        
        // Find the parent test block to get the test name
        let testBlock = path;
        let testName = '';
        while (testBlock && testBlock.parent) {
          if (testBlock.node.type === 'CallExpression' && 
              testBlock.node.callee && 
              (testBlock.node.callee.name === 'it' || testBlock.node.callee.name === 'test')) {
            testName = testBlock.node.arguments[0].value;
            break;
          }
          testBlock = testBlock.parent;
        }

        // Find the current test name for this mock implementation
        let currentTestBlock = path;
        let currentTestName = '';
        while (currentTestBlock && currentTestBlock.parent) {
          if (currentTestBlock.node.type === 'CallExpression' && 
              currentTestBlock.node.callee && 
              (currentTestBlock.node.callee.name === 'it' || currentTestBlock.node.callee.name === 'test')) {
            currentTestName = currentTestBlock.node.arguments[0].value;
            break;
          }
          currentTestBlock = currentTestBlock.parent;
        }

        const key = `${objName}.${methodName}.${currentTestName}`;
        // Get only the chains for this specific test
        const currentTestChains = stubChains.get(key) || [];

        for (const chain of currentTestChains) {
          console.log('Outputting chain:', key, chain.returnValue?.callee?.property?.name);
        }
        
        // Create the mock implementation
        const mockImplementation = j.arrowFunctionExpression as any;
        const mockImpl = mockImplementation(
          [j.restElement(j.identifier('args'))],
          j.blockStatement([
            ...currentTestChains.filter(chain => chain).map(chain => {
              // If chain has args array but it's empty, or has no args property
              if (!chain.args || chain.args.length === 0) {
                return j.returnStatement(chain.returnValue);
              }
              
              return j.ifStatement(
                chain.args.reduce((expr, arg, index) => {
                  const condition = j.binaryExpression(
                    '===',
                    j.memberExpression(
                      j.identifier('args'),
                      j.literal(index),
                      true
                    ),
                    arg
                  );
                  
                  return index === 0
                    ? j.logicalExpression(
                        '&&',
                        j.binaryExpression(
                          '>',
                          j.memberExpression(
                            j.identifier('args'),
                            j.identifier('length')
                          ),
                          j.literal(0)
                        ),
                        condition
                      )
                    : j.logicalExpression('&&', expr, condition);
                }, null as any),
                j.blockStatement([
                  j.returnStatement(chain.returnValue || j.identifier('undefined'))
                ])
              );
            }),
            // Only add default return if we have conditional chains
            ...(currentTestChains.some(chain => chain.args && chain.args.length > 0) 
              ? [j.returnStatement(j.identifier('undefined'))]
              : [])
          ])
        );

        // Create the mock.method() call
        const mockCall = j.callExpression(
          j.memberExpression(j.identifier('mock'), j.identifier('method')),
          [
            j.tsAsExpression(
              j.memberExpression(
                j.identifier(objName),
                j.identifier('prototype')
              ),
              j.tsAnyKeyword()
            ),
            j.literal(
              args[1].type === 'TSAsExpression' 
                ? args[1].expression.value || args[1].expression.name
                : args[1].type === 'StringLiteral'
                ? args[1].value
                : args[1].type === 'Literal'
                ? args[1].value
                : args[1].name || ''
            ),
            mockImpl
          ]
        );

        // Replace the original stub declaration directly with the mock.method call
        j(path.parent.parent).replaceWith(
          j.expressionStatement(mockCall)
        );

        // Find and remove all chain calls for this stub
        const stubVarName = path.parent.node.id?.name;
        if (stubVarName) {
          // Get all references to this stub variable
          const references = root
            .find(j.Identifier, { name: stubVarName })
            .filter(idPath => {
              // Walk up to find if this is part of a chain
              let current = idPath;
              while (current.parent) {
                if (current.parent.node.type === 'ExpressionStatement') {
                  const expr = current.parent.node.expression;
                  if (j.CallExpression.check(expr)) {
                    // Check if this is a withArgs/returns/resolves chain
                    let chainNode = expr;
                    while (chainNode && j.CallExpression.check(chainNode)) {
                      const callee = chainNode.callee;
                      if (j.MemberExpression.check(callee) && 
                          j.Identifier.check(callee.property) &&
                          ['withArgs', 'returns', 'resolves'].includes(callee.property.name)) {
                        return true;
                      }
                      // Move up the chain
                      chainNode = callee.object;
                    }
                  }
                  break;
                }
                current = current.parent;
              }
              return false;
            });

          // Remove each chain expression
          references.forEach(ref => {
            let current = ref;
            while (current.parent && current.parent.node.type !== 'ExpressionStatement') {
              current = current.parent;
            }
            if (current.parent) {
              j(current.parent).remove();
            }
          });
        }
      }
    });


  // Replace sandbox.restore() and sinon.restore() with mock.reset()
  root
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        property: { name: 'restore' }
      }
    })
    .filter(path => {
      const callee = path.node.callee;
      return (
        j.MemberExpression.check(callee) &&
        j.Identifier.check(callee.object) &&
        (callee.object.name === 'sandBox' || callee.object.name === 'sinon')
      );
    })
    .forEach(path => {
      // Find the parent afterEach block if any
      let current = path;
      let isInAfterEach = false;
      while (current.parent) {
        if (current.node.type === 'CallExpression' && 
            current.node.callee.type === 'Identifier' &&
            current.node.callee.name === 'afterEach') {
          isInAfterEach = true;
          break;
        }
        current = current.parent;
      }

      if (isInAfterEach) {
        // For afterEach blocks, only keep one mock.reset() and remove others
        const afterEachBody = current.node.arguments[0].body.body;
        const existingReset = afterEachBody.find(stmt => 
          stmt.type === 'ExpressionStatement' &&
          stmt.expression.type === 'CallExpression' &&
          stmt.expression.callee.type === 'MemberExpression' &&
          stmt.expression.callee.object.name === 'mock' &&
          stmt.expression.callee.property.name === 'reset'
        );

        if (!existingReset) {
          // Replace this restore() with mock.reset()
          j(path.parent).replaceWith(
            j.expressionStatement(
              j.callExpression(
                j.memberExpression(j.identifier('mock'), j.identifier('reset')),
                []
              )
            )
          );
        } else {
          // Remove this restore() call entirely
          j(path.parent).remove();
        }
      } else {
        // Outside afterEach, replace normally with mock.reset()
        j(path.parent).replaceWith(
          j.expressionStatement(
            j.callExpression(
              j.memberExpression(j.identifier('mock'), j.identifier('reset')),
              []
            )
          )
        );
      }
    });

  return root.toSource();
};

export default transform;