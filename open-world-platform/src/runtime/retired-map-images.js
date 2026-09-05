const KEY = Symbol.for('open-world.retired-map-images');
export const RETIRED_MAP_IMAGES_VERSION = 'retired-map-images-v1';

// Native image onload callbacks outlive Map.remove(). Do not resurrect images
// on a retired renderer; preserve normal calls and errors on a live style.
export function guardRetiredMapImages(map) {
  if (!map) return;
  for (const name of ['hasImage', 'addImage', 'updateImage', 'removeImage']) {
    const original = map[name];
    if (typeof original !== 'function' || original[KEY] === RETIRED_MAP_IMAGES_VERSION) continue;
    const wrapper = function (...args) {
      if (this._removed || !this.style) return name === 'hasImage' ? false : this;
      return original.apply(this, args);
    };
    wrapper[KEY] = RETIRED_MAP_IMAGES_VERSION;
    map[name] = wrapper;
  }
}
