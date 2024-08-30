#!/usr/bin/env node

const { functionName, operatorToken, nameCollectionEvents } = require('./__env')
const { createExecContex } = require('./context')
const handleEvents = require('./lib/events/handle-events')

const path = require('path')
const recursiveReadDir = require('./lib/recursive-read-dir')

// const handleEventBling = require('./lib/pubsub/webhook-bling')

// Firebase SDKs to setup cloud functions and access Firestore database
const admin = require('firebase-admin')
const functions = require('firebase-functions')
admin.initializeApp()

// web server with Express
const express = require('express')
const bodyParser = require('body-parser')
const server = express()
const router = express.Router()
const routes = './routes'

// enable/disable some E-Com common routes based on configuration
const { app, procedures } = require('./ecom.config')

// handle app authentication to Store API
// https://github.com/ecomplus/application-sdk
const { ecomServerIps, setup } = require('@ecomplus/application-sdk')

server.use(bodyParser.urlencoded({ extended: false }))
server.use(bodyParser.json())

server.use((req, res, next) => {
  if (req.url.startsWith('/ecom/')) {
    // get E-Com Plus Store ID from request header
    req.storeId = parseInt(req.get('x-store-id') || req.query.store_id, 10)
    if (req.url.startsWith('/ecom/modules/')) {
      // request from Mods API
      // https://github.com/ecomclub/modules-api
      const { body } = req
      if (typeof body !== 'object' || body === null || !body.params || !body.application) {
        return res.status(406).send('Request not comming from Mods API? Invalid body')
      }
    }

    if (process.env.NODE_ENV !== 'development') {
      if (req.query.store_access_token) {
        // check authentication access token with Store API
        // GET /(auth).json
      }
      // check for operator token
      if (operatorToken !== (req.get('x-operator-token') || req.query.operator_token)) {
        // last check for IP address from E-Com Plus servers
        const clientIp = req.get('x-forwarded-for') || req.connection.remoteAddress
        if (ecomServerIps.indexOf(clientIp) === -1) {
          return res.status(403).send('Who are you? Unauthorized IP address')
        }
      }
    }
  }

  // pass to the endpoint handler
  // next Express middleware
  next()
})

router.get('/', (req, res) => {
  // pretty print application body
  server.set('json spaces', 2)
  require(`${routes}/`)(req, res)
})

const prepareAppSdk = () => {
  // debug ecomAuth processes and ensure enable token updates by default
  process.env.ECOM_AUTH_DEBUG = 'true'
  process.env.ECOM_AUTH_UPDATE = 'enabled'
  // setup ecomAuth client with Firestore instance
  return setup(null, true, admin.firestore())
}

// base routes for E-Com Plus Store API
const routesDir = path.join(__dirname, routes)
recursiveReadDir(routesDir).filter(filepath => filepath.endsWith('.js')).forEach(filepath => {
  // set filename eg.: '/ecom/auth-callback'
  let filename = filepath.replace(routesDir, '').replace(/\.js$/i, '')
  if (path.sep !== '/') {
    filename = filename.split(path.sep).join('/')
  }
  if (filename.charAt(0) !== '/') {
    filename = `/${filename}`
  }

  // ignore some routes
  switch (filename) {
    case '/index':
      // home already set
      return
    case '/ecom/webhook':
      // don't need webhook endpoint if no procedures configured
      if (!procedures.length) {
        return
      }
      break
    default:
      if (filename.startsWith('/ecom/modules/')) {
        // check if module is enabled
        const modName = filename.split('/').pop().replace(/-/g, '_')
        if (!app.modules || !app.modules[modName] || app.modules[modName].enabled === false) {
          return
        }
      }
  }

  // expecting named exports with HTTP methods
  const methods = require(`${routes}${filename}`)
  for (const method in methods) {
    const middleware = methods[method]
    if (middleware) {
      router[method](filename, (req, res) => {
        console.log(`${method} ${filename}`)
        prepareAppSdk().then(appSdk => {
          middleware({ appSdk, admin }, req, res)
        }).catch(err => {
          console.error(err)
          res.status(500)
          res.send({
            error: 'SETUP',
            message: 'Can\'t setup `ecomAuth`, check Firebase console registers'
          })
        })
      })
    }
  }
})

// server.use(createContext)
server.use(router)

exports[functionName] = functions.https.onRequest(createExecContex(server))
console.log(`-- Starting '${app.title}' E-Com Plus app with Function '${functionName}'`)

// schedule update tokens job
const cron = '25 */3 * * *'
exports.updateTokens = functions.pubsub.schedule(cron).onRun(() => {
  return prepareAppSdk().then(appSdk => {
    return appSdk.updateTokens()
  })
})
console.log(`-- Sheduled update E-Com Plus tokens '${cron}'`)

exports.eventsEcomplus = functions.firestore
  .document(`${nameCollectionEvents}_ecomplus/{docId}`)
  .onWrite(createExecContex(handleEvents))

exports.eventsBling = functions.firestore
  .document(`${nameCollectionEvents}_bling/{docId}`)
  .onWrite(createExecContex(handleEvents))

// update token job bling
// const updateBlingToken = require('./lib/bling-auth/renovate-token')
// const cronUpdateBlingToken = '1 */2 * * *'
// exports.syncBlingToken = functions.pubsub.schedule(cronUpdateBlingToken).onRun(updateBlingToken)
// console.log(`-- Sheduled active access from bling '${cronUpdateBlingToken}'`)

// schedule active check queues from Store API
/* const checkIdleQueues = require('./lib/integration/check-idle-queues')
const queueFallbackCron = 'every 60 mins'
exports.scheduledSync = functions.pubsub.schedule(queueFallbackCron).onRun(checkIdleQueues)
console.log(`-- Sheduled active check idle queues from Store API '${queueFallbackCron}'`) */

// delete old stored Bling order states
/* const clearOrderStates = require('./lib/integration/clear-order-states')
const clearStatesCron = '56 13 * * *'
exports.scheduledClear = functions.pubsub.schedule(clearStatesCron).onRun(clearOrderStates)
console.log(`-- Sheduled clearing order stored states '${clearStatesCron}'`) */

// exports.onBlingEvents = require('./lib/pubsub/create-topic')
//   .createEventsFunction('bling', handleEventBling)
