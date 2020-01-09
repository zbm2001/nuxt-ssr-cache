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

  const hookName = 'vue-renderer:ssr:context'
  const hookCaches = {
    // '0': {
    //   [hookName]: {
    //     resolve: resolve
    //   },
    //   routeCachedPromise: {
    //     resolve: resolve,
    //     reject: reject
    //   }
    // }
  }
  const hookCacheIndexes = []
  let hookCacheIndex = -1

  function createHookPromise (hookCacheIndex) {
    let promise = new Promise(function (resolve, reject) {
      hookCaches[hookCacheIndex] = {
        [hookName]: {
          resolve
        }
      }
    })
    return promise
  }

  function createCachedPromise (hookCacheIndex) {
    let promise = new Promise(function (resolve, reject) {
      hookCaches[hookCacheIndex].routeCachedPromise = {
        resolve,
        reject
      }
    })
    return promise
  }

  // SSRRenderer.render @nuxt/vue-renderer/dist/vue-renderer.js
  // 执行到此 hook 时，实际已获取部分全局 css、js 等
  nuxt.hook(hookName, function (renderContext) {
    // This will be called when vue-renderer ssr Context
    // console.log('renderContext.req.url', renderContext.req.url)
    const _hookCacheIndex = renderContext[hookName]
    const hookCache = hookCaches[_hookCacheIndex]
    const hookCachePromise = hookCache[hookName]
    if (renderContext.redirected) {
      // console.log('renderContext.redirected', renderContext.redirected)
      let redirectedResult = {
        html: '',
        cspScriptSrcHashes: [],
        preloadFiles: undefined, // []
        error: null,
        redirected: renderContext.redirected
      }
      hookCachePromise.resolve(redirectedResult);
      // if response redirected, block promise forever
      return new Promise(() => {});
    } else {
      hookCachePromise.resolve();
      return createCachedPromise(_hookCacheIndex);
    }
  })

  renderer.renderRoute = async function (route, context) {
    // hopefully cache reset is finished up to this point.
    tryStoreVersion(cache, currentVersion);

    const cacheKey = (config.cache.key || defaultCacheKeyBuilder)(route, context);
    if (!cacheKey) return renderRoute(route, context);

    let _hookCacheIndex = hookCacheIndexes.pop();
    context[hookName] = _hookCacheIndex > -1 ? _hookCacheIndex : (_hookCacheIndex = ++hookCacheIndex);

    let hookPromise = createHookPromise(_hookCacheIndex);

    let renderRoutePromise = renderRoute(route, context);

    const redirectedResult = await hookPromise;

    if (redirectedResult) {
      clearHookCache();
      return redirectedResult;
    }

    const cachedResult = await cache.getAsync(cacheKey).catch(err => err);

    if (cachedResult && !(cachedResult instanceof Error)) {
      clearHookCache();
      return deserialize(cachedResult);
    } else  {
      const hookCache = hookCaches[_hookCacheIndex];
      const routeCachedPromise = hookCache.routeCachedPromise;
      routeCachedPromise.resolve(route + ' not cached.');
      const result = await renderRoutePromise.catch(err => err);
      if (result && !(result instanceof Error) && !result.error) {
        cache.setAsync(cacheKey, serialize(result));
      }
      clearHookCache();
      return result;
    }

    function clearHookCache () {
      hookCacheIndexes.push(_hookCacheIndex);
      delete hookCaches[_hookCacheIndex];
      delete context[hookName];
      hookPromise = null;
      renderRoutePromise = null;
    }
  };

  return cache;
};
