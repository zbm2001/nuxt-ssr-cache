const path = require('path');
const {serialize, deserialize} = require('./serializer');
const makeCache = require('./cache-builders');


function cleanIfNewVersion (cache, version) {
  if (!version) return;
  return cache.getAsync('appVersion')
    .then(function (oldVersion) {
      if (oldVersion !== version) {
        console.log(`Cache updated from ${oldVersion} to ${version}`);
        return cache.resetAsync();
        // unfortunately multi cache doesn't return a promise
        // and we can't await for it so as to store new version
        // immediately after reset.
      }
    });
}

function tryStoreVersion (cache, version) {
  if (!version || cache.versionSaved) return;
  return cache.setAsync('appVersion', version, {ttl: null})
    .then(() => { cache.versionSaved = true; });
}

module.exports = function cacheRenderer (nuxt, config) {
  // used as a nuxt module, only config is provided as argument
  // and nuxt instance will be provided as this context
  if (arguments.length < 2 && this.nuxt) {
    nuxt = this.nuxt;
    config = this.options;
  }

  if (!config.cache || !Array.isArray(config.cache.pages) || !config.cache.pages.length || !nuxt.renderer) {
    return;
  }

  function isCacheFriendly (path, context) {
    if (typeof (config.cache.isCacheable) === 'function') {
      return config.cache.isCacheable(path, context);
    }

    return !context.res.spa &&
      config.cache.pages.some(pat =>
        pat instanceof RegExp
          ? pat.test(path)
          : path.startsWith(pat)
      );
  }

  function defaultCacheKeyBuilder (route, context) {
    var hostname = context.req && context.req.hostname || context.req && context.req.host;
    if (!hostname) return;
    const cacheKey = config.cache.useHostPrefix === true && hostname
      ? path.join(hostname, route)
      : route;

    if (isCacheFriendly(route, context)) return cacheKey;
  }

  const currentVersion = config.version || config.cache.version;
  const cache = makeCache(config.cache.store);
  cleanIfNewVersion(cache, currentVersion);

  const renderer = nuxt.renderer;
  const renderRoute = renderer.renderRoute.bind(renderer);

  let hookResolve = hookResolvePlaceholder

  function hookResolvePlaceholder () {
    throw new Error('`hookResolve()` needs to be implemented')
  }

  function createHookPromise () {
    let promise = new Promise(function (resolve, reject) {
      hookResolve = resolve
    })
    return promise
  }

  let cachedResolve = cachedResolvePlaceholder

  function cachedResolvePlaceholder () {
    throw new Error('`cachedResolve()` needs to be implemented')
  }

  let cachedReject = cachedRejectPlaceholder

  function cachedRejectPlaceholder () {
    throw new Error('`cachedReject()` needs to be implemented')
  }

  function createCachedPromise () {
    let promise = new Promise(function (resolve, reject) {
      cachedResolve = resolve
      cachedReject = reject
    })
    return promise
  }

  // SSRRenderer.render @nuxt/vue-renderer/dist/vue-renderer.js
  // 执行到此 hook 时，已获取部分内容 css、js 等
  nuxt.hook('vue-renderer:ssr:context', function (renderContext) {
    // This will be called when vue-renderer ssr Context
    // console.log('renderContext.req.url', renderContext.req.url)
    if (renderContext.redirected) {
      // console.log('renderContext.redirected', renderContext.redirected)
      let redirectedResult = {
        html: '',
        cspScriptSrcHashes: [],
        preloadFiles: undefined, // []
        error: null,
        redirected: renderContext.redirected
      }
      hookResolve(redirectedResult)
      hookResolve = hookResolvePlaceholder
      return Promise.reject(renderContext.redirected)
    } else {
      hookResolve()
      hookResolve = hookResolvePlaceholder
      return createCachedPromise()
    }
  })

  renderer.renderRoute = function (route, context) {
    // hopefully cache reset is finished up to this point.
    tryStoreVersion(cache, currentVersion);

    const cacheKey = (config.cache.key || defaultCacheKeyBuilder)(route, context);
    if (!cacheKey) return renderRoute(route, context);

    const hookPromise = createHookPromise()

    let renderRoutePromise = renderRoute(route, context).catch(err => err)

    return hookPromise.then(function (redirectedResult) {
      if (redirectedResult) {
        return redirectedResult
      }
      return cache.getAsync(cacheKey)
        .then(function (cachedResult) {
          if (cachedResult) {
            cachedReject(route + ' cached.')
            cachedReject = cachedRejectPlaceholder
            cachedResolve = cachedResolvePlaceholder
            // renderRoutePromise.then(function (result) { console.log(result.redirected) })
            renderRoutePromise = null
            return deserialize(cachedResult);
          }
          cachedResolve(route + ' not cached.')
          cachedReject = cachedRejectPlaceholder
          cachedResolve = cachedResolvePlaceholder
          return renderSetCache();
        })
        .catch(renderSetCache);
    })

    function renderSetCache () {
      return renderRoutePromise
        .then(function (result) {
          if (!result.error) {
            cache.setAsync(cacheKey, serialize(result));
          }
          return result;
        });
    }
  };

  return cache;
};
