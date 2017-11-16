const
  path = require('path')
  fs = require('fs'),
  merge = require('webpack-merge'),
  chokidar = require('chokidar'),
  debounce = require('lodash.debounce')

const
  generateWebpackConfig = require('./build/webpack-config'),
  appPaths = require('./build/app-paths'),
  logger = require('./helpers/logger'),
  log = logger('app:quasar-conf'),
  warn = logger('app:quasar-conf', 'red')

function getQuasarConfigCtx (opts) {
  const ctx = {
    dev: opts.dev || false,
    prod: opts.prod || false,
    theme: {},
    themeName: opts.theme,
    mode: {},
    modeName: opts.mode,
    target: {},
    targetName: opts.target,
    arch: {},
    archName: opts.arch,
    debug: opts.debug
  }
  ctx.theme[opts.theme] = true
  ctx.mode[opts.mode] = true
  if (opts.target) {
    ctx.target[opts.target] = true
  }
  if (opts.arch) {
    ctx.arch[opts.arch] = true
  }
  return ctx
}

function encode (obj) {
  return JSON.stringify(obj, (key, value) => {
    return typeof value === 'function'
      ? `/fn(${value.toString()})`
      : value
  })
}

function ensureSlashEnding (path) {
  return !path || path.endsWith('/')
    ? path
    : `${path}/`
}

class QuasarConfig {
  constructor (opts) {
    this.filename = appPaths.resolve.app('quasar.conf.js')
    this.opts = opts
    this.ctx = getQuasarConfigCtx(opts)

    this.watch = opts.onBuildChange || opts.onAppChange
    this.refresh()

    if (this.watch) {
      // Start watching for quasar.config.js changes
      chokidar
        .watch(this.filename, { watchers: { chokidar: { ignoreInitial: true } } })
        .on('change', debounce(() => {
          let err = false
          log(`quasar.conf.js changed`)

          try {
            this.refresh()
          }
          catch (e) {
            err = true
            warn(`quasar.conf.js has errors. Please fix them then save file again.`)
            warn()
            console.log(e)
          }

          if (err) { return }

          if (this.webpackConfigChanged) {
            opts.onBuildChange()
          }
          else {
            opts.onAppChange()
          }
        }), 2500)
    }
  }

  getBuildConfig () {
    return this.buildConfig
  }

  getWebpackConfig () {
    return this.webpackConfig
  }

  getElectronWebpackConfig () {
    return this.electronWebpackConfig
  }

  refresh () {
    let config

    log(`Parsing quasar.conf.js`)

    if (fs.existsSync(this.filename)) {
      delete require.cache[this.filename]
      config = require(this.filename)
    }
    else {
      warn(`[FAIL] Could not load quasar.conf.js config file`)
      process.exit(1)
    }

    const cfg = config(this.ctx)

    cfg.ctx = this.ctx

    // if watching for changes,
    // then determine the type (webpack related or not)
    if (this.watch) {
      const newConfigSnapshot = [
        cfg.build ? encode(cfg.build) : '',
        cfg.devServer ? encode(cfg.devServer) : '',
        cfg.vendor ? encode(cfg.vendor) : '',
        cfg.pwa ? encode(cfg.pwa) : '',
        cfg.electron ? encode(cfg.electron) : ''
      ].join('')

      if (this.oldConfigSnapshot) {
        this.webpackConfigChanged = newConfigSnapshot !== this.oldConfigSnapshot
      }

      this.oldConfigSnapshot = newConfigSnapshot
    }

    // make sure it exists
    cfg.supportIE = this.ctx.mode.electron
      ? false
      : (cfg.supportIE || false)

    cfg.build = merge({
      extractCSS: this.ctx.prod,
      sourceMap: this.ctx.dev,
      minify: this.ctx.prod,
      distDir: `dist-${this.ctx.modeName}-${this.ctx.themeName}`,
      htmlFilename: 'index.html',
      webpackManifest: this.ctx.prod,
      useNotifier: true,
      vueRouterMode: 'hash',
      devtool: this.ctx.dev
        ? '#cheap-module-eval-source-map'
        : '#source-map',
      env: {
        NODE_ENV: `"${this.ctx.prod ? 'production' : 'development'}"`,
        DEV: this.ctx.dev,
        PROD: this.ctx.prod,
        THEME: `"${this.ctx.themeName}"`,
        MODE: `"${this.ctx.modeName}"`
      }
    }, cfg.build || {})

    if (this.ctx.dev || this.ctx.debug) {
      cfg.build.minify = false
      cfg.build.extractCSS = false
      cfg.build.gzip = false
    }
    if (this.ctx.debug) {
      cfg.build.sourceMap = true
      cfg.build.extractCSS = true
    }

    if (this.ctx.mode.cordova || this.ctx.mode.electron) {
      cfg.build.htmlFilename = 'index.html'
      cfg.build.vueRouterMode = 'hash'
      cfg.build.gzip = false
      cfg.build.webpackManifest = false
    }

    if (this.ctx.mode.cordova) {
      cfg.build.distDir = path.join('src-cordova', 'www')
    }
    if (this.ctx.mode.electron) {
      cfg.build.packagedElectronDist = cfg.build.distDir
      cfg.build.distDir = path.join(cfg.build.distDir, 'UnPackaged')
    }

    cfg.build.publicPath =
      this.ctx.prod && cfg.build.publicPath && !['cordova', 'electron'].includes(this.ctx.modeName)
        ? ensureSlashEnding(cfg.build.publicPath)
        : (cfg.build.vueRouterMode !== 'hash' ? '/' : '')
    cfg.build.appBase = cfg.build.publicPath || './'

    if (this.ctx.dev) {
      cfg.devServer = merge({
        contentBase: appPaths.srcDir,
        publicPath: cfg.build.publicPath,
        hot: true,
        inline: true,
        overlay: true,
        quiet: true,
        historyApiFallback: true,
        noInfo: true,
        disableHostCheck: true,
        host: this.opts.host,
        port: this.opts.port,
        open: true
      }, cfg.devServer || {})

      if (process.env.PORT) {
        cfg.devServer.port = process.env.PORT
      }
      if (process.env.HOSTNAME) {
        cfg.devServer.host = process.env.HOSTNAME
      }
      if (this.ctx.mode.cordova) {
        cfg.devServer.https = false
        cfg.devServer.open = false

        // TODO ensure string / array cases
        cfg.devServer.contentBase = [
          cfg.devServer.contentBase,
          appPaths.resolve.cordova(`platforms/${this.ctx.targetName}/platform_www`)
        ]
      }
    }

    if (cfg.build.gzip) {
      let gzip = cfg.build.gzip === true
        ? {}
        : cfg.build.gzip
      let ext = ['js', 'css']

      if (gzip.extensions) {
        ext = gzip.extensions
        delete gzip.extensions
      }

      cfg.build.gzip = merge({
        asset: '[path].gz[query]',
        algorithm: 'gzip',
        test: new RegExp('\\.(' + ext.join('|') + ')$'),
        threshold: 10240,
        minRatio: 0.8
      }, gzip)
    }

    if (this.ctx.mode.pwa) {
      const pkg = require(appPaths.resolve.app('package.json'))
      cfg.build.webpackManifest = false

      cfg.pwa = merge({
        cacheId: pkg.name || 'quasar-pwa-app',
        filename: 'service-worker.js',
        cacheExt: 'js,html,css,woff,ttf,eot,otf,woff,woff2,json,svg,gif,jpg,jpeg,png,wav,ogg,webm,flac,aac,mp4,mp3',
        manifest: {
          name: pkg.productName || pkg.name || 'Quasar App',
          short_name: pkg.name || 'quasar-pwa',
          description: pkg.description,
          display: 'standalone'
        }
      }, cfg.pwa || {})

      cfg.pwa.manifest.start_url = `${cfg.build.publicPath}${cfg.build.htmlFilename}`
      cfg.pwa.manifest.icons = cfg.pwa.manifest.icons.map(icon => {
        icon.src = `${cfg.build.publicPath}${icon.src}`
        return icon
      })
    }

    if (this.ctx.dev) {
      cfg.build.APP_URL = `http${cfg.devServer.https ? 's' : ''}://${cfg.devServer.host}:${cfg.devServer.port}/${cfg.build.vueRouterMode === 'hash' ? cfg.build.htmlFilename : ''}`
    }
    else if (this.ctx.mode.cordova) {
      cfg.build.APP_URL = 'index.html'
    }
    else if (this.ctx.mode.electron) {
      cfg.build.APP_URL = `file://" + __dirname + "/index.html`
    }

    cfg.build.env = merge(cfg.build.env, {
      VUE_ROUTER_MODE: `"${cfg.build.vueRouterMode}"`,
      VUE_ROUTER_BASE: this.ctx.prod && cfg.build.vueRouterMode === 'history'
        ? `"${cfg.build.publicPath}"`
        : `"/"`,
      APP_URL: `"${cfg.build.APP_URL}"`
    })

    cfg.build.env = {
      'process.env': cfg.build.env
    }
    if (this.ctx.mode.electron) {
      if (this.ctx.dev) {
        cfg.build.env.__statics = `"${appPaths.resolve.src('statics').replace(/\\/g, '\\\\')}"`
      }
    }
    else {
      cfg.build.env.__statics = `"${this.ctx.dev ? '/' : cfg.build.publicPath || '/'}statics"`
    }

    log(`Generating Webpack config`)
    let webpackConfig = generateWebpackConfig(cfg)

    if (typeof cfg.build.extendWebpack === 'function') {
      log(`Extending Webpack config`)
      cfg.build.extendWebpack(webpackConfig)
    }

    this.webpackConfig = webpackConfig

    if (this.ctx.mode.cordova && !cfg.cordova) {
      cfg.cordova = {}
    }

    if (this.ctx.mode.electron) {
      log(`Generating Electron Webpack config`)
      const
        electronWebpack = require('./build/webpack-electron-config'),
        electronWebpackConfig = electronWebpack(cfg)

      cfg.electron = merge({
        packager: {
          asar: true,
          dir: appPaths.resolve.app(cfg.build.distDir),
          icon: appPaths.resolve.electron('icons/icon'),
          out: appPaths.resolve.app(cfg.build.packagedElectronDist),
          overwrite: true
        }
      }, cfg.electron || {})

      if (cfg.ctx.targetName) {
        cfg.electron.packager.platform = cfg.ctx.targetName
      }
      if (cfg.ctx.archName) {
        cfg.electron.packager.arch = cfg.ctx.archName
      }

      if (typeof cfg.electron.extendWebpack === 'function') {
        log(`Extending Electron Webpack config`)
        cfg.electron.extendWebpack(electronWebpackConfig)
      }

      this.electronWebpackConfig = electronWebpackConfig
    }

    this.buildConfig = cfg
  }
}

module.exports = QuasarConfig
