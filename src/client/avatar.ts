/**
 * R17-G12 (mission acceptance 12): the deterministic minimal pixel avatar.
 *
 * `avatarCells(name)` is a pure function of the name: an FNV-1a hash of the
 * salted name grows an 8x8 grid that is mirrored about its vertical axis, filled
 * with 3 or 4 colours from the fixed palette below, and emitted as one cell per
 * lit pixel. Identity is carried by the name text; the sprite is decoration.
 *
 * The properties the round's test asserts over the whole 40-name pool:
 *  - deterministic and pure: the same name always yields the same sprite, with
 *    no shared state, no call order and no I/O — the module imports nothing,
 *    reads no asset and makes no request;
 *  - symmetric: every cell has its mirror with the same colour;
 *  - palette-bound: 3 or 4 distinct colours, each taken from `AVATAR_PALETTE`
 *    (the first `n` lit pairs take each selected colour once, so the count is a
 *    structural property, not a probabilistic one);
 *  - rect-bounded: between 20 and 30 lit mirror pairs, i.e. 40..60 SVG rects;
 *  - distinct over the pool: 40 names yield 40 distinct sprites. A collision is
 *    broken by salting the hash deterministically — `salt` re-derives the whole
 *    family through the same function, so the fix for a future collision is one
 *    constant (`AVATAR_SALT_BASE`) or one salt step, never a hand-drawn
 *    per-name exception (no pool name appears in this module).
 *
 * Rendering lives in `MissionProgress.tsx`: inline `<rect>`s with
 * `shape-rendering: crispEdges`, inside an `aria-hidden` `<svg>`. No image
 * asset, no network, no new dependency, no new event kind, no model turn.
 */

/** The sprite is an 8x8 grid, mirrored left/right about its vertical axis. */
export const AVATAR_GRID = 8
/** One grid cell is this many SVG user units, so `crispEdges` has integers to snap to. */
export const AVATAR_CELL = 4
/** The asserted upper bound on drawn rects (30 lit mirror pairs). */
export const AVATAR_MAX_CELLS = 60
/** The asserted lower bound on lit mirror pairs, so a sprite is never a sliver. */
export const AVATAR_MIN_PAIRS = 20
/** The one salt constant: raising it re-derives every sprite deterministically. */
export const AVATAR_SALT_BASE = 0
/** The fixed palette; a sprite selects 3 or 4 of these by rotation from its seed. */
export const AVATAR_PALETTE = ['#2b3a55', '#4f6d7a', '#c0d6df', '#e8dab2'] as const

export interface AvatarCell { x: number; y: number; color: string }
export interface AvatarSprite { grid: number; cell: number; colors: readonly string[]; cells: readonly AvatarCell[] }

const HALF = AVATAR_GRID / 2
const MAX_PAIRS = AVATAR_MAX_CELLS / 2
const MAX_SALT_STEPS = 8

/** FNV-1a, 32-bit: the hash family the sprite is derived from. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * One avalanche step, applied to an FNV-1a result before the sprite consumes its
 * many bits per cell. FNV-1a's final round is an XOR with one byte followed by a
 * multiply by an odd constant, so its LOW bits depend almost only on the low bits
 * of the input bytes: measured over the pool, the raw 2-bit decisions collapsed
 * 40 names onto 4 distinct lit-patterns. The high bits are fine, but the sprite
 * needs independent decisions per cell, so the hash is finalized here instead of
 * changing `fnv1a32`, which stays the published FNV-1a with its published
 * vectors (see the test).
 */
function mix32(hash: number): number {
  let value = hash >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0
  return (value ^ (value >>> 15)) >>> 0
}

/** One deterministic sprite for `name` at `salt`; the salt is mixed into every hash. */
function build(name: string, salt: number): AvatarSprite {
  const seed = mix32(fnv1a32(`${name}\u0000${salt}`))
  const colourCount = 3 + ((seed >>> 31) & 1)
  const start = (seed >>> 27) % AVATAR_PALETTE.length
  const colors = Array.from({ length: colourCount }, (_, index) => AVATAR_PALETTE[(start + index) % AVATAR_PALETTE.length]!)
  const pairs: AvatarCell[] = []
  for (let y = 0; y < AVATAR_GRID; y++) {
    for (let x = 0; x < HALF; x++) {
      const cellHash = mix32(fnv1a32(`${name}\u0000${salt}\u0000${x}:${y}`))
      if ((cellHash & 3) === 0) continue
      // The first `colourCount` lit pairs take each selected colour once, so the
      // 3-or-4-colour and palette invariants hold by construction; the rest are
      // chosen from the same set by the cell hash.
      const color = pairs.length < colourCount ? colors[pairs.length]! : colors[(cellHash >>> 2) % colourCount]!
      pairs.push({ x, y, color })
    }
  }
  const cells: AvatarCell[] = []
  for (const pair of pairs) {
    cells.push({ x: pair.x, y: pair.y, color: pair.color }, { x: AVATAR_GRID - 1 - pair.x, y: pair.y, color: pair.color })
  }
  return { grid: AVATAR_GRID, cell: AVATAR_CELL, colors, cells }
}

/**
 * The sprite for `name`. Purely a function of the name (and, for a caller that
 * needs to widen it, the salt): the salt ladder below only advances when a
 * sprite would fall outside the declared pair band, and it advances
 * deterministically from the caller's salt, so the result is stable for every
 * input and every call order.
 */
export function avatarCells(name: string, salt = AVATAR_SALT_BASE): AvatarSprite {
  for (let step = 0; step < MAX_SALT_STEPS; step++) {
    const sprite = build(name, salt + step)
    const pairs = sprite.cells.length / 2
    if (pairs >= AVATAR_MIN_PAIRS && pairs <= MAX_PAIRS) return sprite
  }
  return build(name, salt)
}
