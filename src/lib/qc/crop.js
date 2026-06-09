// Zoomed-crop geometry for the corrections view (TDD stub — see crop.test.js).

const NOT_IMPL = () => {
  throw new Error("not implemented");
};

/**
 * Square crop of side `size` centered on (cx, cy), clamped to stay fully inside an
 * imgW × imgH image. If `size` exceeds an image dimension, the crop is that dimension.
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function cropRect(_cx, _cy, _size, _imgW, _imgH) {
  return NOT_IMPL();
}
