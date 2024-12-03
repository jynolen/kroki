/* global XMLSerializer */
import path from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { logger } from './logger.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export class TimeoutError extends Error {
  constructor (timeoutDurationMs, action = 'convert') {
    super(`Timeout error: ${action} took more than ${timeoutDurationMs}ms`)
  }
}

export class SyntaxError extends Error {
  constructor (err) {
    super('Syntax error in graph', { cause: err })
    logger.error(this)
    this.name = 'SyntaxError'
    this.message = err.message
  }
}

export class Worker {
  constructor (browserInstance) {
    this.browserWSEndpoint = browserInstance.wsEndpoint()
    this.pageUrl = process.env.KROKI_DIAGRAMSNET_PAGE_URL || `file://${path.join(__dirname, '..', 'assets', 'index.html')}`
    this.convertTimeout = process.env.KROKI_DIAGRAMSNET_CONVERT_TIMEOUT || '15000'
  }

  /**
   *
   * @param  {string} source
   * @param  {boolean} performResolveImage
   * @returns {Promise<string|Buffer>}
   */
  async browserRender (source, performResolveImage) {
    const resolveImage = async function (svg) {
      for (const img of await svg.querySelectorAll('image')) {
        if (img.attributes['xlink:href'].value.startsWith('data:')) {
          continue
        }
        const imgb64 = await fetch(img.attributes['xlink:href'].value).then(async (value) => {
          const mimeType = value.headers.get('content-type')
          const b64img = btoa(String.fromCharCode(...new Uint8Array(await value.arrayBuffer())))
          return `data:${mimeType};base64,${b64img}`
        })
        img.setAttribute('xlink:href', imgb64)
        img.removeAttribute('pointer-events')
      }
      return svg
    }
    const s = new XMLSerializer()
    let svgRoot = render({ // eslint-disable-line no-undef
      xml: source,
      format: 'svg'
    }).getSvg()
    svgRoot = performResolveImage ? await resolveImage(svgRoot) : svgRoot
    return s.serializeToString(svgRoot)
  }

  /**
   * @param task
   * @returns {Promise<string|Buffer>}
   */
  async convert (task) {
    const browser = await puppeteer.connect({
      browserWSEndpoint: this.browserWSEndpoint,
      ignoreHTTPSErrors: true
    })
    const page = await browser.newPage()
    page.on('console', msg => {
      console.log(msg.text())
    })
    try {
      await page.setViewport({ height: 800, width: 600 })
      await page.goto(this.pageUrl)
      const evalResult = await Promise.race([
        page.evaluate(this.browserRender, task.source, task.isUnsafe).catch((err) => { throw new SyntaxError(err) }),
        new Promise((resolve, reject) => setTimeout(() => reject(new TimeoutError(this.convertTimeout)), this.convertTimeout))
      ])

      // const bounds = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('bounds'))
      // const pageId = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('page-id'))
      // const scale = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('scale'))
      // const pageCount = parseInt(await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('pageCount')))
      if (task.isPng) {
        await page.setContent(`<!DOCTYPE html>  
<html>
<head>  
<meta name='viewport' content='initial-scale=1.0, user-scalable=no' />  
<meta http-equiv='Content-Type' content='text/html; charset=utf-8' />  
</head>  
<body> 
${evalResult}
</body>
</html>`)
        const container = await page.$('svg')
        return Buffer.from(await container.screenshot({
          type: 'png',
          omitBackground: true
        }))
      } else {
        return evalResult
      }
    } finally {
      try {
        await page.close()
      } catch (err) {
        logger.warn({ err }, 'Unable to close the page')
      }
      try {
        await browser.disconnect()
      } catch (err) {
        logger.warn({ err }, 'Unable to disconnect from the browser')
      }
    }
  }
}
