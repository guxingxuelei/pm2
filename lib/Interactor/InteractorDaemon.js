
'use strict';

var fs = require('fs');
var rpc = require('pm2-axon-rpc');
var axon = require('pm2-axon');
var log = require('debug')('interactor:daemon');
var os = require('os');
var pkg = require('../../package.json');
var dns = require('dns');
var cst = require('../../constants.js');
var ReverseInteractor = require('./ReverseInteractor.js');
var PushInteractor = require('./PushInteractor.js');
var Utility = require('./Utility.js');
var WatchDog = require('./WatchDog.js');
var Conf = require('../Configuration.js');
var PM2Client = require('./PM2Client.js');
var WebsocketTransport = require('./WebsocketTransport.js');

// use noop if not launched via IPC
if (!process.send) {
  process.send = function () {};
}

var InteractorDaemon = module.exports = function () {
  this.opts = this.retrieveConf();
  this.DAEMON_ACTIVE = false;
  this.transport = null;
  this.httpClient = new Utility.HTTPCLient();
};

/**
 * Get an interface for communicating with PM2 daemon
 * @private
 * @return {PM2Client}
 */
InteractorDaemon.prototype.getPM2Client = function () {
  if (!this._ipm2) {
    this._ipm2 = new PM2Client();
  }
  return this._ipm2;
};

/**
 * Terminate connections and exit
 * @param {Error} err if provided, the exit code will be set to cst.ERROR_EXIT
 */
InteractorDaemon.prototype.exit = function (err) {
  if (this._workerEndpoint) {
    clearInterval(this._workerEndpoint);
  }

  if (this._workerConnectivity) {
    clearInterval(this._workerConnectivity);
  }

  this._ipm2.disconnect(function () {
    console.log('Closed connection to PM2 bus and RPC server');
  });

  this.pm2.disconnect(function () {
    console.log('Closed connection to PM2 API');
  });

  process.nextTick(function () {
    try {
      fs.unlinkSync(cst.INTERACTOR_RPC_PORT);
      fs.unlinkSync(cst.INTERACTOR_PID_PATH);
    } catch (err) {}

    console.log('Exiting Interactor');

    if (!this._rpc || !this._rpc.sock) {
      return process.exit(cst.ERROR_EXIT);
    }

    this._rpc.sock.close(function () {
      console.log('RPC server closed');
      process.exit(err ? cst.ERROR_EXIT : cst.SUCCESS_EXIT);
    });
  });
};

/**
 * Start a RPC server and expose it throught a socket file
 */
InteractorDaemon.prototype.startRPC = function (opts) {
  console.log('Launching Interactor RPC server (bind to %s)', cst.INTERACTOR_RPC_PORT);

  var self = this;
  var rep = axon.socket('rep');
  var rpcServer = new rpc.Server(rep);
  rep.bind(cst.INTERACTOR_RPC_PORT);

  rpcServer.expose({
    kill: function (cb) {
      console.log('Shutdown request received via RPC');
      cb(null);
      return self.exit();
    },
    passwordSet: function (cb) {
      global._pm2_password_protected = true;
      return cb(null);
    },
    getInfos: function (cb) {
      if (self.opts && self.DAEMON_ACTIVE === true) {
        return cb(null, {
          machine_name: self.opts.MACHINE_NAME,
          public_key: self.opts.PUBLIC_KEY,
          secret_key: self.opts.SECRET_KEY,
          remote_host: self.transport._host,
          connected: self.transport.isConnected(),
          socket_path: cst.INTERACTOR_RPC_PORT,
          pm2_home_monitored: cst.PM2_HOME
        });
      } else {
        return cb(null);
      }
    }
  });
  return rpcServer;
};

/**
 * Retrieve metadata about the system
 */
InteractorDaemon.prototype.getSystemMetadata = function () {
  return {
    MACHINE_NAME: this.opts.MACHINE_NAME,
    PUBLIC_KEY: this.opts.PUBLIC_KEY,
    RECYCLE: this.opts.RECYCLE || false,
    PM2_VERSION: pkg.version,
    MEMORY: os.totalmem() / 1000 / 1000,
    HOSTNAME: os.hostname(),
    CPUS: os.cpus()
  };
};

/**
 * Is internet reachable via DNS
 * @private
 * @param {Function} cb invoked with <boolean> [optional]
 */
InteractorDaemon.prototype._checkInternet = function (cb) {
  var self = this;
  dns.lookup('google.com', function (err) {
    if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) {
      if (self._online) {
        console.error('[CRITICAL] Internet is unreachable (via DNS lookup strategy)');
      }
      self._online = false;
    } else {
      if (!self._online) {
        console.log('[TENTATIVE] Internet is reachable again, re-connecting');
        self.transport.reconnect();
      }
      self._online = true;
    }
    return typeof cb === 'function' ? cb(self._online) : 0;
  });
};

/**
 * Ping root url to retrieve node info
 * @private
 * @param {Function} cb invoked with <Error, Object> where Object is the response sended by the server
 */
InteractorDaemon.prototype._pingRoot = function (cb) {
  var data = this.getSystemMetadata();
  data = Utility.Cipher.cipherMessage(JSON.stringify(data), this.opts.SECRET_KEY);
  if (!data) return cb(new Error('Failed to retrieve/cipher system metadata'));

  this.httpClient.open({
    url: this.opts.ROOT_URL + '/api/node/verifyPM2',
    method: 'POST',
    data: {
      public_id: this.opts.PUBLIC_KEY,
      data: data
    }
  }, cb);
};

/**
 * Ping root to verify retrieve and connect to the km endpoint
 * @private
 * @param {Function} cb invoked with <Error, Boolean>
 */
InteractorDaemon.prototype._verifyEndpoint = function (cb) {
  var self = this;
  this._pingRoot(function (err, data) {
    if (err) return cb(err);
    self.km_data = data;

    if (data.disabled === true || data.pending === true) {
      return cb(new Error('Interactor disabled, contact us at contact@keymetrics.io for more informatios'));
    }
    if (data.active === false) return cb(null, false);

    if (self.transport === null) {
      self.transport = new WebsocketTransport(self.opts, self);
      self.transport.start(data.endpoints.push, cb);
    } else if (data.endpoints.push !== self.km_data.endpoints.push) {
      self.transport.reconnect(cb);
    }
    return cb(null, true);
  });
};

/**
 * Retrieve configuration from environnement
 */
InteractorDaemon.prototype.retrieveConf = function () {
  var opts = {};

  opts.MACHINE_NAME = process.env.PM2_MACHINE_NAME;
  opts.PUBLIC_KEY = process.env.PM2_PUBLIC_KEY;
  opts.SECRET_KEY = process.env.PM2_SECRET_KEY;
  opts.RECYCLE = process.env.KM_RECYCLE ? JSON.parse(process.env.KM_RECYCLE) : false;
  opts.REVERSE_INTERACT = JSON.parse(process.env.PM2_REVERSE_INTERACT);
  opts.PM2_VERSION = pkg.version;

  if (!opts.MACHINE_NAME) {
    console.error('You must provide a PM2_MACHINE_NAME environment variable');
    process.exit(cst.ERROR_EXIT);
  } else if (!opts.PUBLIC_KEY) {
    console.error('You must provide a PM2_PUBLIC_KEY environment variable');
    process.exit(cst.ERROR_EXIT);
  } else if (!opts.SECRET_KEY) {
    console.error('You must provide a PM2_SECRET_KEY environment variable');
    process.exit(cst.ERROR_EXIT);
  }
  return opts;
};

/**
 * Ping root url to retrieve node info
 * @private
 * @param {Function} cb invoked with <Error> [optional]
 */
InteractorDaemon.prototype.start = function (cb) {
  var self = this;
  this._ipm2 = new PM2Client();
  this.pm2 = require('../..');

  this.pm2.connect(function (err) {
    return err ? console.error(err) : console.log('Connected to PM2');
  });

  this._rpc = this.startRPC();

  this.opts.ROOT_URL = cst.KEYMETRICS_ROOT_URL;
  if (cst.DEBUG) {
    this.opts.ROOT_URL = process.env.NODE_ENV === 'test'
      ? '127.0.0.1:3400' : '127.0.0.1:3000';
  }

  if (Conf.getSync('pm2:passwd')) {
    global._pm2_password_protected = true;
  }

  this._verifyEndpoint(function (err, result) {
    if (err) {
      process.send({ error: true, msg: err.message || err });
      console.error(err);
      return self.exit();
    }
    if (result === false) return self.exit();

    // send data over IPC for CLI feedback
    process.send({
      error: false,
      km_data: self.km_data,
      online: true,
      pid: process.pid,
      machine_name: self.opts.MACHINE_NAME,
      public_key: self.opts.PUBLIC_KEY,
      secret_key: self.opts.SECRET_KEY,
      reverse_interaction: self.opts.REVERSE_INTERACT
    });

    // start workers
    self._workerConnectivity = setInterval(self._checkInternet.bind(self), 10000);
    self._workerEndpoint = setInterval(self._verifyEndpoint.bind(self), 60000 * 2);
    self.push = new PushInteractor(self.opts, self._ipm2, self.transport);
    self.reverse = new ReverseInteractor(self.opts, self.pm2, self.transport);
    self.push.start();
  });
};

// If its the entry file launch the daemon
// otherwise we just required it to use a function
if (require.main === module) {
  console.log('[Keymetrics.io] Launching agent');
  process.title = 'PM2: KM Agent (' + process.env.PM2_HOME + ')';
  new InteractorDaemon().start();
}

