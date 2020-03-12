const ensureIterable = require('type/iterable/ensure')
const ensureString = require('type/string/ensure')
const random = require('ext/string/random')
const path = require('path')
const { Component } = require('@serverless/core')
const fs = require('fs')

const DEFAULTS = {
  handler: 'index.main_handler',
  runtime: 'Python3.6',
  exclude: ['.git/**', '.gitignore', '.DS_Store']
}

class TencentTornado extends Component {
  getDefaultProtocol(protocols) {
    if (protocols.map((i) => i.toLowerCase()).includes('https')) {
      return 'https'
    }
    return 'http'
  }

  async copyDir(src, dst) {
    const paths = await fs.readdirSync(src)
    if (!fs.existsSync(dst)) {
      await fs.mkdirSync(dst)
    }
    for (let i = 0; i < paths.length; i++) {
      const thisFileStat = await fs.statSync(path.join(src, paths[i]))
      if (thisFileStat.isFile()) {
        const readable = await fs.readFileSync(path.join(src, paths[i]))
        await fs.writeFileSync(path.join(dst, paths[i]), readable)
      } else {
        if (!fs.existsSync(path.join(dst, paths[i]))) {
          await fs.mkdirSync(path.join(dst, paths[i]))
        }
        await this.copyDir(path.join(src, paths[i]), path.join(dst, paths[i]))
      }
    }
  }

  mergeJson(sourceJson, targetJson) {
    for (const eveKey in sourceJson) {
      if (targetJson.hasOwnProperty(eveKey)) {
        if (['protocols', 'endpoints', 'customDomain'].indexOf(eveKey) != -1) {
          for (let i = 0; i < sourceJson[eveKey].length; i++) {
            const sourceEvents = JSON.stringify(sourceJson[eveKey][i])
            const targetEvents = JSON.stringify(targetJson[eveKey])
            if (targetEvents.indexOf(sourceEvents) == -1) {
              targetJson[eveKey].push(sourceJson[eveKey][i])
            }
          }
        } else {
          if (typeof sourceJson[eveKey] != 'string') {
            this.mergeJson(sourceJson[eveKey], targetJson[eveKey])
          } else {
            targetJson[eveKey] = sourceJson[eveKey]
          }
        }
      } else {
        targetJson[eveKey] = sourceJson[eveKey]
      }
    }
    return targetJson
  }

  async prepareInputs(inputs = {}) {
    // 对function inputs进行标准化
    const tempFunctionConf = inputs.functionConf ? inputs.functionConf : undefined
    const functionConf = {
      name:
        ensureString(inputs.functionName, { isOptional: true }) ||
        this.state.functionName ||
        `TornadoComponent_${random({ length: 6 })}`,
      codeUri:
        ensureString(
          tempFunctionConf && tempFunctionConf.code ? tempFunctionConf.code : inputs.code,
          { isOptional: true }
        ) || process.cwd(),
      region: inputs.region
        ? typeof inputs.region == 'string'
          ? [inputs.region]
          : inputs.region
        : ['ap-guangzhou'],
      handler: ensureString(
        tempFunctionConf && tempFunctionConf.handler ? tempFunctionConf.handler : inputs.handler,
        { default: DEFAULTS.handler }
      ),
      runtime: ensureString(
        tempFunctionConf && tempFunctionConf.runtime ? tempFunctionConf.runtime : inputs.runtime,
        { default: DEFAULTS.runtime }
      ),
      fromClientRemark: inputs.fromClientRemark || 'tencent-tornado'
    }
    functionConf.include = ensureIterable(
      tempFunctionConf && tempFunctionConf.include ? tempFunctionConf.include : inputs.include,
      { default: [], ensureItem: ensureString }
    )
    functionConf.exclude = ensureIterable(
      tempFunctionConf && tempFunctionConf.exclude ? tempFunctionConf.exclude : inputs.exclude,
      { default: [], ensureItem: ensureString }
    )
    functionConf.include.push(path.join(functionConf.codeUri, '.cache'))
    functionConf.exclude.push('.git/**', '.gitignore', '.serverless', '.DS_Store')
    if (inputs.functionConf) {
      functionConf.timeout = inputs.functionConf.timeout ? inputs.functionConf.timeout : 3
      functionConf.memorySize = inputs.functionConf.memorySize
        ? inputs.functionConf.memorySize
        : 128
      if (inputs.functionConf.environment) {
        functionConf.environment = inputs.functionConf.environment
      }
      if (inputs.functionConf.vpcConfig) {
        functionConf.vpcConfig = inputs.functionConf.vpcConfig
      }
    }

    // 中间件，对入口文件进行额外处理
    const src = path.join(__dirname, 'component')
    const dst = path.join(functionConf.codeUri, '.cache')
    await this.copyDir(src, dst)
    const indexPyFile = await fs.readFileSync(
      path.join(path.resolve(functionConf.codeUri), '.cache', 'index.py'),
      'utf8'
    )
    const replacedFile = indexPyFile.replace(
      eval('/{{tornado_project}}/g'),
      inputs.tornadoProjectName
    )
    await fs.writeFileSync(
      path.join(path.resolve(functionConf.codeUri), '.cache', 'index.py'),
      replacedFile
    )

    // 对apigw inputs进行标准化
    const apigatewayConf = inputs.apigatewayConf ? inputs.apigatewayConf : {}
    apigatewayConf.fromClientRemark = inputs.fromClientRemark || 'tencent-tornado'
    apigatewayConf.serviceName = inputs.serviceName
    apigatewayConf.description = 'Serverless Framework Tencent-Tornado Component'
    apigatewayConf.serviceId = inputs.serviceId
    apigatewayConf.region = functionConf.region
    apigatewayConf.protocols = apigatewayConf.protocols || ['http']
    apigatewayConf.environment = apigatewayConf.environment ? apigatewayConf.environment : 'release'
    apigatewayConf.endpoints = [
      {
        path: '/',
        method: 'ANY',
        function: {
          isIntegratedResponse: true,
          functionName: functionConf.name
          functionNamespace: functionConf.namespace
        }
      }
    ]

    // 对cns inputs进行标准化
    const tempCnsConf = {}
    const tempCnsBaseConf = inputs.cloudDNSConf ? inputs.cloudDNSConf : {}

    // 分地域处理functionConf/apigatewayConf/cnsConf
    for (let i = 0; i < functionConf.region.length; i++) {
      if (inputs[functionConf.region[i]] && inputs[functionConf.region[i]].functionConf) {
        functionConf[functionConf.region[i]] = inputs[functionConf.region[i]].functionConf
      }
      if (inputs[functionConf.region[i]] && inputs[functionConf.region[i]].apigatewayConf) {
        apigatewayConf[functionConf.region[i]] = inputs[functionConf.region[i]].apigatewayConf
      }

      const tempRegionCnsConf = this.mergeJson(
        tempCnsBaseConf,
        inputs[functionConf.region[i]] && inputs[functionConf.region[i]].cloudDNSConf
          ? inputs[functionConf.region[i]].cloudDNSConf
          : {}
      )

      tempCnsConf[functionConf.region[i]] = {
        recordType: 'CNAME',
        recordLine: tempRegionCnsConf.recordLine ? tempRegionCnsConf.recordLine : undefined,
        ttl: tempRegionCnsConf.ttl,
        mx: tempRegionCnsConf.mx,
        status: tempRegionCnsConf.status ? tempRegionCnsConf.status : 'enable'
      }
    }

    const cnsConf = []

    // 对cns inputs进行检查和赋值
    if (apigatewayConf.customDomain && apigatewayConf.customDomain.length > 0) {
      for (let domianNum = 0; domianNum < apigatewayConf.customDomain.length; domianNum++) {
        const tencentDomain = await this.load('@serverless/tencent-domain')
        const domainData = await tencentDomain.check({
          domain: apigatewayConf.customDomain[domianNum].domain
        })
        const tempInputs = {
          domain: domainData.domain,
          records: []
        }
        for (let eveRecordNum = 0; eveRecordNum < functionConf.region.length; eveRecordNum++) {
          if (tempCnsConf[functionConf.region[eveRecordNum]].recordLine) {
            tempInputs.records.push({
              subDomain: domainData.subDomain || '@',
              recordType: 'CNAME',
              recordLine: tempCnsConf[functionConf.region[eveRecordNum]].recordLine,
              value: `temp_value_about_${functionConf.region[eveRecordNum]}`,
              ttl: tempCnsConf[functionConf.region[eveRecordNum]].ttl,
              mx: tempCnsConf[functionConf.region[eveRecordNum]].mx,
              status: tempCnsConf[functionConf.region[eveRecordNum]].status || 'enable'
            })
          }
        }
        cnsConf.push(tempInputs)
      }
    }

    return {
      region: functionConf.region,
      functionConf: functionConf,
      apigatewayConf: apigatewayConf,
      cnsConf: cnsConf
    }
  }

  async default(inputs = {}) {
    if (!inputs.tornadoProjectName) {
      throw new Error(`'tornadoProjectName' is required in serverless.yaml`)
    }

    const state = {
      apigw: `apigateway`,
      func: `function`,
      cns: []
    }
    inputs = await this.prepareInputs(inputs)

    const tencentCloudFunction = await this.load('@serverless/tencent-scf-multi-region', state.func)
    const tencentApiGateway = await this.load(
      '@serverless/tencent-apigateway-multi-region',
      state.apigw
    )

    const tencentFunctionOutputs = await tencentCloudFunction(inputs.functionConf)
    const tencentApiGatewayOutputs = await tencentApiGateway(inputs.apigatewayConf)

    const outputs = {
      functionName: inputs.functionConf.name
    }

    const cnsRegion = {}

    if (inputs.region.length == 1) {
      outputs.region = inputs.region[0]
      outputs.apiGatewayServiceId = tencentApiGatewayOutputs[inputs.region[0]].serviceId
      outputs.url = `${this.getDefaultProtocol(
        tencentApiGatewayOutputs[inputs.region[0]].protocols
      )}://${tencentApiGatewayOutputs[inputs.region[0]].subDomain}/${
        tencentApiGatewayOutputs[inputs.region[0]].environment
      }/`
      cnsRegion[inputs.region[0]] = tencentApiGatewayOutputs[inputs.region[0]].subDomain
    } else {
      for (let i = 0; i < inputs.region.length; i++) {
        const tempData = {
          apiGatewayServiceId: tencentApiGatewayOutputs[inputs.region[i]].serviceId,
          url: `${this.getDefaultProtocol(
            tencentApiGatewayOutputs[inputs.region[i]].protocols
          )}://${tencentApiGatewayOutputs[inputs.region[i]].subDomain}/${
            tencentApiGatewayOutputs[inputs.region[i]].environment
          }/`
        }
        cnsRegion[inputs.region[i]] = tencentApiGatewayOutputs[inputs.region[i]].subDomain
        outputs[inputs.region[i]] = tempData
      }
    }

    for (let i = 0; i < inputs.cnsConf.length; i++) {
      for (let j = 0; j < inputs.cnsConf[i].records.length; j++) {
        inputs.cnsConf[i].records[j].value =
          cnsRegion[inputs.cnsConf[i].records[j].value.replace('temp_value_about_', '')]
      }
      const tencentCns = await this.load('@serverless/tencent-cns', inputs.cnsConf[i].domain)
      const tencentCnsOutputs = await tencentCns(inputs.cnsConf[i])
      if (tencentCnsOutputs.DNS) {
        outputs.DNS = tencentCnsOutputs.DNS
      }
      state.cns.push(inputs.cnsConf[i].domain)
    }

    this.state = state
    await this.save()
    return outputs
  }

  async remove(inputs = {}) {
    const removeInput = {
      fromClientRemark: inputs.fromClientRemark || 'tencent-tornado'
    }

    const tencentCloudFunction = await this.load(
      '@serverless/tencent-scf-multi-region',
      this.state.func
    )
    const tencentApiGateway = await this.load(
      '@serverless/tencent-apigateway-multi-region',
      this.state.apigw
    )

    await tencentCloudFunction.remove(removeInput)
    await tencentApiGateway.remove(removeInput)

    for (let i = 0; i < this.state.cns.length; i++) {
      const tencentCns = await this.load('@serverless/tencent-cns', this.state.cns[i])
      await tencentCns.remove(removeInput)
    }

    return {}
  }
}

module.exports = TencentTornado
