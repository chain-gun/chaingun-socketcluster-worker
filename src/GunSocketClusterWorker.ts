import { createGraphAdapter } from '@chaingun/http-adapter'
import { verify } from '@chaingun/sear'
import { GunGraphAdapter, GunMsg } from '@chaingun/types'
import express from 'express'
import morgan from 'morgan'
import healthChecker from 'sc-framework-health-check'
import { SCServerSocket } from 'socketcluster-server'
// tslint:disable-next-line: no-submodule-imports
import SCWorker from 'socketcluster/scworker'

export class GunSocketClusterWorker extends SCWorker {
  public readonly adapter: GunGraphAdapter
  public readonly httpServer: any
  public readonly scServer: any
  public readonly options: any

  constructor(...args) {
    super(...args)
    this.adapter = this.setupAdapter()
  }

  public run(): void {
    this.httpServer.on('request', this.setupExpress())
    this.setupMiddleware()
  }

  public isAdmin(socket: SCServerSocket): boolean {
    return (
      socket.authToken && socket.authToken.pub === process.env.GUN_OWNER_PUB
    )
  }

  protected setupAdapter(): GunGraphAdapter {
    const url = process.env.GUN_HTTP_PERSIST_URL

    if (!url) {
      throw new Error('GUN_HTTP_PERSIST_URL not set')
    }

    return createGraphAdapter(url)
  }

  protected setupMiddleware(): void {
    this.scServer.addMiddleware(
      this.scServer.MIDDLEWARE_SUBSCRIBE,
      this.onSubscribeMiddleware.bind(this)
    )

    this.scServer.addMiddleware(
      this.scServer.MIDDLEWARE_PUBLISH_IN,
      this.writeValidationMiddleware.bind(this)
    )

    this.scServer.on('connection', socket => {
      socket.on('login', (req, respond) =>
        this.authenticateLogin(socket, req, respond)
      )
    })
  }

  protected setupExpress(): express.Express {
    const environment = this.options.environment
    const app = express()

    if (environment === 'dev') {
      // Log every HTTP request.
      // See https://github.com/expressjs/morgan for other available formats.
      app.use(morgan('dev'))
    }
    // Listen for HTTP GET "/health-check".
    healthChecker.attach(this, app)

    return app
  }

  /**
   * Authenticate a connection for extra privileges
   *
   * @param req
   */
  protected async authenticateLogin(
    socket: SCServerSocket,
    req: {
      readonly pub: string
      readonly proof: {
        readonly m: string
        readonly s: string
      }
    },
    respond: {
      (arg0: null, arg1: string): void
      (arg0?: Error): void
      (arg0: null, arg1: string): void
    }
  ): Promise<void> {
    if (!req.pub || !req.proof) {
      respond(null, 'Missing login info')
      return
    }

    try {
      const [socketId, timestampStr] = req.proof.m.split('/')
      const timestamp = parseInt(timestampStr, 10)
      const now = new Date().getTime()
      const drift = Math.abs(now - timestamp)
      const maxDrift =
        (process.env.SC_AUTH_MAX_DRIFT &&
          parseInt(process.env.SC_AUTH_MAX_DRIFT, 10)) ||
        1000 * 60 * 5

      if (drift > maxDrift) {
        respond(new Error('Exceeded max clock drift'))
        return
      }

      if (!socketId || socketId !== socket.id) {
        respond(new Error("Socket ID doesn't match"))
        return
      }

      const isVerified = await verify(req.proof, req.pub)
      if (isVerified) {
        socket.setAuthToken({
          pub: req.pub,
          timestamp
        })
        respond()
      } else {
        respond(null, 'Invalid login')
      }
    } catch (err) {
      respond(null, 'Invalid login')
    }
  }

  protected onSubscribeMiddleware(
    req: any,
    next: (arg0?: Error) => void
  ): void {
    if (req.channel === 'gun/put' || req.channel === 'gun/get') {
      if (!this.isAdmin(req.socket)) {
        next(new Error(`You aren't allowed to subscribe to ${req.channel}`))
        return
      }
    }

    const soul = req.channel.replace(/^gun\/nodes\//, '')
    if (!soul || soul === req.channel) {
      next()
      return
    }

    next()
    ;(async () => {
      const msgId = Math.random()
        .toString(36)
        .slice(2)

      this.scServer.exchange.publish('gun/get/validated', {
        '#': msgId,
        get: {
          '#': soul
        }
      })

      setTimeout(async () => {
        try {
          const node = await this.adapter.get(soul)

          req.socket.emit('#publish', {
            channel: req.channel,
            data: {
              '#': msgId,
              '@': 'wtf',
              put: node
                ? {
                    [soul]: node
                  }
                : null
            }
          })
        } catch (e) {
          // tslint:disable-next-line: no-console
          console.warn(e.stack || e)
          req.socket.emit('#publish', {
            channel: req.channel,
            data: {
              '#': msgId,
              '@': req['#'],
              err: 'Error fetching node'
            }
          })
        }
      }, 10)
    })()
  }

  protected writeValidationMiddleware(
    req: any,
    next: (arg0?: Error | boolean) => void
  ): void {
    if (req.channel !== 'gun/get' && req.channel !== 'gun/put') {
      if (this.isAdmin(req.socket)) {
        next()
      } else {
        next(new Error("You aren't allowed to write to this channel"))
      }
      return
    }

    this.persistMiddleware(req, next)
  }

  protected async persistMiddleware(
    req: any,
    next: (arg0?: Error | boolean) => void
  ): Promise<void> {
    next()

    if (req.channel !== 'gun/put' || !req.data || !req.data.put) {
      return
    }

    const msg = req.data

    req.socket.emit('#publish', {
      channel: `gun/@${msg['#']}`,
      data: await this.processPut(msg)
    })
  }

  /**
   * Persist put data and publish any resulting diff
   *
   * @param msg
   */
  protected async processPut(msg: GunMsg): Promise<GunMsg> {
    const msgId = Math.random()
      .toString(36)
      .slice(2)

    try {
      const diff = msg.put && (await this.adapter.put(msg.put))

      this.publishDiff({
        ...msg,
        put: diff
      })

      return {
        '#': msgId,
        '@': msg['#'],
        err: null,
        ok: true
      }
    } catch (e) {
      return {
        '#': msgId,
        '@': msg['#'],
        err: 'Error saving',
        ok: false
      }
    }
  }

  /**
   * Send put data to node subscribers as a diff
   *
   * @param msg
   */
  protected publishDiff(msg: GunMsg): void {
    const msgId = msg['#']
    const diff = msg.put

    if (!diff) {
      return
    }

    const exchange = this.scServer.exchange

    for (const soul in diff) {
      if (!soul) {
        continue
      }

      const nodeDiff = diff[soul]

      if (!nodeDiff) {
        continue
      }

      exchange.publish(`gun/nodes/${soul}`, {
        '#': `${msgId}/${soul}`,
        put: {
          [soul]: nodeDiff
        }
      })
    }

    exchange.publish('gun/put/diff', msg)
  }
}
