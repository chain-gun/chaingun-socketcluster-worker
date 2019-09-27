import SCWorker from "socketcluster/scworker"
import express from "express"
import morgan from "morgan"
import healthChecker from "sc-framework-health-check"
import { verify } from "@notabug/gun-sear"
import { SCServerSocket } from "socketcluster-server"

export class GunSocketClusterWorker extends SCWorker {
  httpServer: any
  scServer: any
  options: any

  run() {
    console.log("   >> Worker PID:", process.pid)
    this.httpServer.on("request", this.setupExpress())
    this.setupMiddleware()
  }

  setupMiddleware() {
    this.scServer.addMiddleware(
      this.scServer.MIDDLEWARE_SUBSCRIBE,
      this.onSubscribeMiddleware.bind(this)
    )

    this.scServer.addMiddleware(
      this.scServer.MIDDLEWARE_PUBLISH_IN,
      this.writeValidationMiddleware.bind(this) as any
    )

    this.scServer.on("connection", socket => {
      socket.on("login", (req, respond) =>
        this.authenticateLogin(socket, req, respond)
      )
    })
  }

  setupExpress() {
    const environment = this.options.environment
    const app = express()
    if (environment === "dev") {
      // Log every HTTP request.
      // See https://github.com/expressjs/morgan for other available formats.
      app.use(morgan("dev"))
    }
    // Listen for HTTP GET "/health-check".
    healthChecker.attach(this, app)

    return app
  }

  isAdmin(socket: SCServerSocket) {
    return (
      socket.authToken && socket.authToken.pub === process.env.GUN_OWNER_PUB
    )
  }

  /**
   * Authenticate a connection for extra privileges
   *
   * @param req
   */
  async authenticateLogin(
    socket: SCServerSocket,
    req: {
      pub: string
      proof: {
        m: string
        s: string
      }
    },
    respond: {
      (arg0: null, arg1: string): void
      (arg0: Error): void
      (): void
      (arg0: null, arg1: string): void
    }
  ) {
    if (!req.pub || !req.proof) {
      respond(null, "Missing login info")
      return
    }

    try {
      const [socketId, timestampStr] = req.proof.m.split("/")
      const timestamp = parseInt(timestampStr)
      const now = new Date().getTime()
      const drift = Math.abs(now - timestamp)
      const maxDrift =
        (process.env.SC_AUTH_MAX_DRIFT &&
          parseInt(process.env.SC_AUTH_MAX_DRIFT)) ||
        1000 * 60 * 5

      if (drift > maxDrift) {
        respond(new Error("Exceeded max clock drift"))
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
        console.log("valid login ", req)
        respond()
      } else {
        console.warn("Invalid login", req, isVerified)
        respond(null, "Invalid login")
      }
    } catch (err) {
      console.error("Login error", req)
      respond(null, "Invalid login")
    }
  }

  onSubscribeMiddleware(req: any, next: { (arg0: Error): void; (): void }) {
    if (req.channel === "gun/put" || req.channel === "gun/get") {
      if (!this.isAdmin(req.socket)) {
        next(new Error(`You aren't allowed to subscribe to ${req.channel}`))
        return
      }
    }

    const soul = req.channel.replace(/^gun\/nodes\//, "")
    if (!soul || soul === req.channel) {
      next()
      return
    }

    next()

    const msgId = Math.random()
      .toString(36)
      .slice(2)

    const responseChannel = this.scServer.exchange.subscribe(`gun/@${msgId}`)

    responseChannel.on("subscribe", () => {
      responseChannel.watch((msg: any) => {
        req.socket.emit("#publish", {
          channel: req.channel,
          data: msg
        })
        responseChannel.unsubscribe()
      })
    })

    this.scServer.exchange.publish("gun/get/validated", {
      "#": msgId,
      get: {
        "#": soul
      }
    })
  }

  writeValidationMiddleware(
    req: any,
    next: { (): void; (arg0: Error | boolean): void }
  ) {
    if (req.channel !== "gun/get" && req.channel !== "gun/put") {
      if (this.isAdmin(req.socket)) {
        next()
      } else {
        next(new Error("You aren't allowed to write to this channel"))
      }
      return
    }
  }
}
