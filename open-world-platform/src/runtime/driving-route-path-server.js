const ROUTE_PATH_FETCH_GENERATION = 1;
const PATCH = '__openWorldDrivingRoutePathPatch__';

const PATH_URL = /^map:\/\/paths\/([^/?#]+)\/([^/?#]+)$/;

export function parseDrivingRoutePathRequest(url) {
  const match = PATH_URL.exec(String(url ?? ''));
  if (!match) return null;
  try {
    return { city: decodeURIComponent(match[1]), popId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  return input?.url ?? '';
}

function usable(coordinates) {
  return Array.isArray(coordinates)
    && coordinates.length >= 2
    && coordinates.every((coordinate) => (
      Array.isArray(coordinate)
      && coordinate.length >= 2
      && Number.isFinite(coordinate[0])
      && Number.isFinite(coordinate[1])
    ));
}

function notFound() {
  return new Response('', { status: 404 });
}

/**
 * Install the game's `map://paths/<city>/<pop>` adapter once.
 *
 * `owns` keeps wrappers from different mods composable. Owned requests are
 * resolved without probing the game's known-missing endpoint; a resolver miss
 * becomes the same quiet 404 that makes the native UI draw its straight fallback.
 */
export function installDrivingRoutePathFetch(host, { owns, resolve }) {
  if (!host || typeof host.fetch !== 'function') return () => {};
  if (typeof owns !== 'function' || typeof resolve !== 'function') {
    throw new Error('Driving route path installation requires owns and resolve functions');
  }

  const current = host.fetch?.[PATCH];
  if (current?.generation === ROUTE_PATH_FETCH_GENERATION) {
    const binding = { owns, resolve };
    current.binding = binding;
    return () => {
      if (current.binding !== binding || host.fetch !== current.wrapper) return;
      host.fetch = current.original;
    };
  }

  // A hot reload may leave an older wrapper closure on the page. Restore its
  // native predecessor before attaching this generation so wrappers never stack.
  if (current?.original && current.wrapper === host.fetch) host.fetch = current.original;

  const original = host.fetch;
  const realFetch = original.bind(host);
  const patch = {
    generation: ROUTE_PATH_FETCH_GENERATION,
    original,
    wrapper: null,
    binding: { owns, resolve },
  };
  const wrapper = async (input, init) => {
    const request = parseDrivingRoutePathRequest(requestUrl(input));
    if (!request || !patch.binding.owns(request.city, request.popId)) {
      return realFetch(input, init);
    }
    try {
      const coordinates = await patch.binding.resolve(request.city, request.popId);
      if (!usable(coordinates)) return notFound();
      return new Response(JSON.stringify({ coordinates }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      return notFound();
    }
  };
  patch.wrapper = wrapper;
  Object.defineProperty(wrapper, PATCH, { value: patch, configurable: true });
  host.fetch = wrapper;

  const binding = patch.binding;
  return () => {
    if (patch.binding !== binding || host.fetch !== wrapper) return;
    host.fetch = original;
  };
}

export const drivingRoutePathFetchGeneration = ROUTE_PATH_FETCH_GENERATION;
