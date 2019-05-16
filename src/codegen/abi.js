const immutable = require('immutable')

const tsCodegen = require('./typescript')
const typesCodegen = require('./types')
const util = require('./util')

module.exports = class AbiCodeGenerator {
  constructor(abi) {
    this.abi = abi
  }

  generateModuleImports() {
    return [
      tsCodegen.moduleImports(
        [
          // Base classes
          'EthereumCall',
          'EthereumEvent',
          'SmartContract',
          'EthereumValue',
          'JSONValue',
          'TypedMap',
          'Entity',
          'EthereumTuple',

          // AssemblyScript types
          'Bytes',
          'Address',
          'BigInt',
        ],
        '@graphprotocol/graph-ts',
      ),
    ]
  }

  generateTypes() {
    return [
      ...this._generateEventTypes(),
      ...this._generateSmartContractClass(),
      ...this._generateCallTypes(),
    ]
  }

  _generateCallTypes() {
    let callFunctions = util.disambiguateNames({
      values: this.abi.callFunctions(),
      getName: fn =>
        fn.get('name') || (fn.get('type') === 'constructor' ? 'constructor' : 'default'),
      setName: (fn, name) => fn.set('_alias', name),
    })

    return callFunctions
      .map(fn => {
        let fnAlias = fn.get('_alias')
        let fnClassName = `${fnAlias.charAt(0).toUpperCase()}${fnAlias.slice(1)}Call`
        let tupleClasses = []

        // First, generate a class with the input getters
        let inputsClassName = fnClassName + '__Inputs'
        let inputsClass = tsCodegen.klass(inputsClassName, { export: true })
        inputsClass.addMember(tsCodegen.klassMember('_call', fnClassName))
        inputsClass.addMethod(
          tsCodegen.method(
            `constructor`,
            [tsCodegen.param(`call`, fnClassName)],
            null,
            `this._call = call`,
          ),
        )

        // Generate getters and classes for function inputs
        util
          .disambiguateNames({
            values: fn.get('inputs', immutable.List()),
            getName: (input, index) => input.get('name') || `value${index}`,
            setName: (input, name) => input.set('name', name),
          })
          .forEach((input, index) => {
            let callInput = this._generateInputOrOutput(
              input,
              index,
              fnClassName,
              `call`,
              `inputValues`,
            )
            inputsClass.addMethod(callInput.getter)
            tupleClasses.push(...callInput.classes)
          })

        // Second, generate a class with the output getters
        let outputsClassName = fnClassName + '__Outputs'
        let outputsClass = tsCodegen.klass(outputsClassName, { export: true })
        outputsClass.addMember(tsCodegen.klassMember('_call', fnClassName))
        outputsClass.addMethod(
          tsCodegen.method(
            `constructor`,
            [tsCodegen.param(`call`, fnClassName)],
            null,
            `this._call = call`,
          ),
        )

        // Generate getters and classes for function outputs
        util
          .disambiguateNames({
            values: fn.get('outputs', immutable.List()),
            getName: (output, index) => output.get('name') || `value${index}`,
            setName: (output, name) => output.set('name', name),
          })
          .forEach((output, index) => {
            let callInput = this._generateInputOrOutput(
              output,
              index,
              fnClassName,
              `call`,
              `outputValues`,
            )
            outputsClass.addMethod(callInput.getter)
            tupleClasses.push(...callInput.classes)
          })

        // Then, generate the event class itself
        let klass = tsCodegen.klass(fnClassName, {
          export: true,
          extends: 'EthereumCall',
        })
        klass.addMethod(
          tsCodegen.method(
            `get inputs`,
            [],
            tsCodegen.namedType(inputsClassName),
            `return new ${inputsClassName}(this)`,
          ),
        )
        klass.addMethod(
          tsCodegen.method(
            `get outputs`,
            [],
            tsCodegen.namedType(outputsClassName),
            `return new ${outputsClassName}(this)`,
          ),
        )
        return [klass, inputsClass, outputsClass, ...tupleClasses]
      })
      .reduce(
        // flatten the array
        (array, classes) => array.concat(classes),
        [],
      )
  }

  _generateEventTypes() {
    // Enumerate events with duplicate names
    let events = util.disambiguateNames({
      values: this.abi.data.filter(member => member.get('type') === 'event'),
      getName: event => event.get('name'),
      setName: (event, name) => event.set('_alias', name),
    })

    return events
      .map(event => {
        let eventClassName = event.get('_alias')
        let tupleClasses = []

        // First, generate a class with the param getters
        let paramsClassName = eventClassName + '__Params'
        let paramsClass = tsCodegen.klass(paramsClassName, { export: true })
        paramsClass.addMember(tsCodegen.klassMember('_event', eventClassName))
        paramsClass.addMethod(
          tsCodegen.method(
            `constructor`,
            [tsCodegen.param(`event`, eventClassName)],
            null,
            `this._event = event`,
          ),
        )

        // Enumerate inputs with duplicate names
        let inputs = util.disambiguateNames({
          values: event.get('inputs'),
          getName: (input, index) => input.get('name') || `param${index}`,
          setName: (input, name) => input.set('name', name),
        })

        inputs.forEach((input, index) => {
          // Generate getters and classes for event params
          let paramObject = this._generateInputOrOutput(
            input,
            index,
            eventClassName,
            `event`,
            `parameters`,
          )
          paramsClass.addMethod(paramObject.getter)
          tupleClasses.push(...paramObject.classes)
        })

        // Then, generate the event class itself
        let klass = tsCodegen.klass(eventClassName, {
          export: true,
          extends: 'EthereumEvent',
        })
        klass.addMethod(
          tsCodegen.method(
            `get params`,
            [],
            tsCodegen.namedType(paramsClassName),
            `return new ${paramsClassName}(this)`,
          ),
        )
        return [klass, paramsClass, ...tupleClasses]
      })
      .reduce(
        // flatten the array
        (array, classes) => array.concat(classes),
        [],
      )
  }

  _generateInputOrOutput(inputOrOutput, index, parentClass, parentType, parentField) {
    // Get name and type of the param, adjusting for indexed params and missing names
    let name = inputOrOutput.get('name')
    let valueType =
      parentType === 'event' && inputOrOutput.get('indexed')
        ? this._indexedInputType(inputOrOutput.get('type'))
        : inputOrOutput.get('type')

    if (name === undefined || name === null || name === '') {
      name = parentType === 'event' ? `param${index}` : `value${index}`
    }

    // Generate getters and classes for the param (classes only created for EthereumTuple types)
    return valueType === 'tuple'
      ? this._generateTupleType(
          inputOrOutput,
          index,
          parentClass,
          parentType,
          parentField,
        )
      : {
          getter: tsCodegen.method(
            `get ${name}`,
            [],
            typesCodegen.ascTypeForEthereum(valueType),
            `
            return ${typesCodegen.ethereumValueToAsc(
              parentType === 'tuple'
                ? `this[${index}]`
                : `this._${parentType}.${parentField}[${index}].value`,
              valueType,
            )}
            `,
          ),
          classes: [],
        }
  }

  _generateTupleType(inputOrOutput, index, parentClass, parentType, parentField) {
    let name = inputOrOutput.get('name')
    if (name === undefined || name === null || name === '') {
      name = parentType === 'event' ? `param${index}` : `value${index}`
    }

    let tupleIdentifier = parentClass + tsCodegen.namedType(name).capitalize()
    let tupleClassName = tupleIdentifier + 'Struct'
    let tupleClasses = []

    // Generate getter for parent class
    let tupleGetter = tsCodegen.method(
      `get ${name}`,
      [],
      tupleClassName,
      `
      return ${typesCodegen.ethereumValueToAsc(
        parentType === 'tuple'
          ? `this[${index}]`
          : `this._${parentType}.${parentField}[${index}].value`,
        'tuple',
      )} as ${tupleClassName}
      `,
    )

    // Generate tuple class
    let baseTupleClass = tsCodegen.klass(tupleClassName, {
      export: true,
      extends: 'EthereumTuple',
    })

    // Add param getters to tuple class and generate classes for each tuple parameter
    inputOrOutput.get('components').forEach((component, index) => {
      let name = component.get('name')
      let paramObject = this._generateInputOrOutput(
        component,
        index,
        tupleIdentifier,
        `tuple`,
      )
      baseTupleClass.addMethod(paramObject.getter)
      tupleClasses = tupleClasses.concat(paramObject.classes)
    })

    // Combine all tuple classes generated
    tupleClasses.unshift(baseTupleClass)

    return {
      getter: tupleGetter,
      classes: tupleClasses,
    }
  }

  _generateTupleClassName(parentClass, name, index) {
    if (name === undefined || name === null || name === '') {
      name = `value` + index
    }
    return parentClass + tsCodegen.namedType(name).capitalize() + 'Struct'
  }

  _generateSmartContractClass() {
    let klass = tsCodegen.klass(this.abi.name, { export: true, extends: 'SmartContract' })
    let types = immutable.List()

    klass.addMethod(
      tsCodegen.staticMethod(
        'bind',
        immutable.List([
          tsCodegen.param('address', typesCodegen.ascTypeForEthereum('address')),
        ]),
        tsCodegen.namedType(this.abi.name),
        `
        return new ${this.abi.name}('${this.abi.name}', address);
        `,
      ),
    )

    // Get view/pure functions from the contract
    let functions = this.abi.data.filter(
      member =>
        member.get('type') === 'function' &&
        member.get('outputs', immutable.List()).size !== 0 &&
        (member.get('stateMutability') === 'view' ||
          member.get('stateMutability') === 'pure'),
    )

    // Disambiguate functions with duplicate names
    functions = util.disambiguateNames({
      values: functions,
      getName: fn => fn.get('name'),
      setName: (fn, name) => fn.set('_alias', name),
    })

    functions.forEach(member => {
      let fnName = member.get('name')
      let fnAlias = member.get('_alias')

      // Generate a type for the result of calling the function
      let returnType = undefined
      let simpleReturnType = true
      let tupleResultParentType = this.abi.name + '__' + fnAlias + 'Result__'

      // Disambiguate outputs with duplicate names
      let outputs = util.disambiguateNames({
        values: member.get('outputs', immutable.List()),
        getName: (input, index) => input.get('name') || `param${index}`,
        setName: (input, name) => input.set('name', name),
      })
      member = member.set('name', fnAlias)

      if (member.get('outputs', immutable.List()).size > 1) {
        simpleReturnType = false

        // Create a type dedicated to holding the return values
        returnType = tsCodegen.klass(this.abi.name + '__' + fnAlias + 'Result', {
          export: true,
        })

        // Add a constructor to this type
        returnType.addMethod(
          tsCodegen.method(
            'constructor',
            outputs
              .map((output, index) =>
                tsCodegen.param(
                  `value${index}`,
                  output.get('type') === 'tuple'
                    ? this._generateTupleClassName(
                        tupleResultParentType,
                        output.get('name'),
                        index,
                      )
                    : typesCodegen.ascTypeForEthereum(output.get('type')),
                ),
              ),
            null,
            outputs
              .map((output, index) => `this.value${index} = value${index}`)
              .join('\n'),
          ),
        )

        // Add a `toMap(): TypedMap<string,EthereumValue>` function to the return type
        returnType.addMethod(
          tsCodegen.method(
            'toMap',
            [],
            tsCodegen.namedType('TypedMap<string,EthereumValue>'),
            `
            let map = new TypedMap<string,EthereumValue>();
            ${outputs
              .map(
                (output, index) =>
                  `map.set('value${index}', ${typesCodegen.ethereumValueFromAsc(
                    `this.value${index}`,
                    output.get('type'),
                  )})`,
              )
              .join(';')}
            return map;
            `,
          ),
        )

        // Add value0, value1 etc. members to the type
        outputs
          .map((output, index) =>
            tsCodegen.klassMember(
              `value${index}`,
              typesCodegen.ascTypeForEthereum(output.get('type')),
            ),
          )
          .forEach(member => returnType.addMember(member))

        //Create types for Tuple outputs
        outputs.forEach((output, index) => {
          if (output.get('type') === 'tuple') {
            types = types.push(
              this._generateTupleType(
                output,
                index,
                tupleResultParentType,
                'function',
                this.abi.name,
              ).classes,
            )
          }
        })

        // Add the type to the types we'll create
        types = types.push(returnType)

        returnType = tsCodegen.namedType(returnType.name)
      } else {
        let type = outputs
          .get(0)
          .get('type')
        if (type === 'tuple') {
          // Add the Tuple type to the types we'll create
          types = types.push(
            this._generateTupleType(
              outputs.get(0),
              0,
              tupleResultParentType,
              'function',
              this.abi.name,
            ).classes,
          )

          returnType = this._generateTupleClassName(
            tupleResultParentType,
            outputs
              .get(0)
              .get('name'),
            0,
          )
        } else {
          returnType = tsCodegen.namedType(typesCodegen.ascTypeForEthereum(type))
        }
      }

      // Disambiguate inputs with duplicate names
      let inputs = util.disambiguateNames({
        values: member.get('inputs', immutable.List()),
        getName: (input, index) => input.get('name') || `param${index}`,
        setName: (input, name) => input.set('name', name),
      })

      // Generate a type suffix to identify the Tuple inputs to a function
      let tupleInputParentType = this.abi.name + '__' + fnAlias + 'Input__'

      //Create types for Tuple inputs
      inputs.forEach((input, index) => {
        if (input.get('type') === 'tuple') {
          types = types.push(
            this._generateTupleType(
              input,
              index,
              tupleInputParentType,
              'function',
              this.abi.name,
            ).classes,
          )
        }
      })

      // Generate and add a method that implements calling the function on
      // the smart contract
      klass.addMethod(
        tsCodegen.method(
          fnAlias,
          inputs.map((input, index) =>
            tsCodegen.param(
              input.get('name'),
              input.get('type') === 'tuple'
                ? this._generateTupleClassName(
                    tupleInputParentType,
                    input.get('name'),
                    index,
                  )
                : typesCodegen.ascTypeForEthereum(input.get('type')),
            ),
          ),
          returnType,
          `
          let result = super.call(
            '${fnName}',
            [${
              inputs.size > 0
                ? inputs
                    .map(input =>
                      typesCodegen.ethereumValueFromAsc(
                        input.get('name'),
                        input.get('type'),
                      ),
                    )
                    .map(coercion => coercion.toString())
                    .join(', ')
                : ''
            }]
          );
          return ${
            simpleReturnType
              ? typesCodegen.ethereumValueToAsc(
                  'result[0]',
                  outputs
                    .get(0)
                    .get('type'),
                )
              : `new ${returnType.name}(
                  ${outputs
                    .map(
                      (output, index) =>
                        `${typesCodegen.ethereumValueToAsc(
                          `result[${index}]`,
                          output.get('type'),
                        )} ${
                          output.get('type') === 'tuple'
                            ? 'as ' +
                              this._generateTupleClassName(
                                tupleResultParentType,
                                output.get('name'),
                                index,
                              )
                            : ''
                        }`,
                    )
                    .join(', ')}
                )`
          } ${
            outputs
              .get(0)
              .get('type') === 'tuple'
              ? 'as ' + returnType
              : ''
          };`,
        ),
      )
    })

    return [...types, klass]
  }

  _indexedInputType(inputType) {
    // strings, bytes and arrays are encoded and hashed to a bytes32 value
    if (
      inputType === 'string' ||
      inputType === 'bytes' ||
      inputType == 'tuple' ||
      // the following matches arrays of the forms `uint256[]` and `uint256[12356789]`;
      // the value type name doesn't matter here, just that the type name ends with
      // brackets and, optionally, a number inside the brackets
      inputType.match(/\[[0-9]*\]$/g)
    ) {
      return 'bytes32'
    } else {
      return inputType
    }
  }
}
