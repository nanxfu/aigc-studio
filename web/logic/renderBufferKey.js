/**
 * GPU upload cache key for immutable pixel/depth snapshots.
 *
 * A replacement TypedArray is a new snapshot even when selected pixels happen to
 * match. Callers that edit an array in place must increment its revision argument.
 * WeakMap identity avoids scanning megapixel arrays on every animation frame.
 */
const identities = new WeakMap()
let nextIdentity = 1

export function renderBufferKey(data, revision = 0) {
  if (!data || typeof data !== 'object' || !data.length) return 'empty'
  let identity = identities.get(data)
  if (!identity) { identity = nextIdentity++; identities.set(data, identity) }
  return `${identity}:${data.length}:${revision}`
}
