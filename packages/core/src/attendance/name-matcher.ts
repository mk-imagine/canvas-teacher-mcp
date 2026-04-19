import { levenshtein } from '../matching/levenshtein.js'
import type { ZoomParticipant, RosterEntry, MatchResult } from './types.js'

/** Fuzzy auto-match threshold — distances below this are high-confidence matches. */
const AUTO_MATCH_THRESHOLD = 0.30

/** Ambiguous ceiling — distances below this (but >= auto-match) produce candidates. */
const AMBIGUOUS_CEILING = 0.40

/** Maximum distance for unmatched candidates shown in the review file. */
const UNMATCHED_CANDIDATE_CEILING = 0.8

/** Minimum token length for part-to-part comparison (avoids misleading short-token scores). */
const MIN_PART_LENGTH = 3

/**
 * Minimum confidence margin required to auto-match: the top candidate's
 * distance must beat the runner-up's by at least this much. Otherwise the
 * entry is routed to the review file as ambiguous, even if the top distance
 * is below AUTO_MATCH_THRESHOLD. Catches near-ties like "Steve" matching
 * both "Steve Johnson" (0.0) and "Steven Park" (0.167).
 */
const MIN_CONFIDENCE_MARGIN = 0.20

/** Matches parenthesized tokens containing a forward slash, e.g. "(he/him)", "(she/they)". */
const PRONOUN_PATTERN = /^\(.*\/.*\)$/

/**
 * Match Zoom participants to Canvas roster entries using a 4-step pipeline:
 *
 * 1. **Alias map lookup** — check `aliasMap` (keyed by lowercase Zoom name) for a
 *    previously saved mapping.
 * 2. **Exact case-insensitive match** — compare against roster `name` and `sortableName`
 *    (after stripping pronoun-like parenthesized tokens).
 * 3. **Fuzzy Levenshtein match** — splits names into parts and compares both
 *    full-string and part-to-part distances. Distance < AUTO_MATCH_THRESHOLD
 *    auto-matches; AUTO_MATCH_THRESHOLD–AMBIGUOUS_CEILING is ambiguous.
 * 4. **Unmatched** — no viable match found.
 *
 * High-confidence fuzzy matches (step 3) invoke `onAutoMatch(zoomName, canvasUserId)`
 * when provided, so the caller can persist the mapping for future lookups.
 *
 * @param aliasMap - Map of lowercase Zoom name → Canvas userId for persistent mappings.
 * @param onAutoMatch - Optional callback invoked when a high-confidence fuzzy match is
 *   found. Receives the original (non-lowercased) Zoom display name and Canvas userId.
 */
export function matchAttendance(
  participants: ZoomParticipant[],
  roster: RosterEntry[],
  aliasMap: Map<string, number>,
  onAutoMatch?: (zoomName: string, canvasUserId: number) => void
): MatchResult {
  const result: MatchResult = {
    matched: [],
    ambiguous: [],
    unmatched: [],
  }

  const rosterByUserId = new Map<number, RosterEntry>()
  for (const entry of roster) {
    rosterByUserId.set(entry.userId, entry)
  }

  for (const participant of participants) {
    // Step 1: Alias map lookup
    const mappedUserId = aliasMap.get(participant.name.toLowerCase())
    if (mappedUserId !== undefined) {
      const rosterEntry = rosterByUserId.get(mappedUserId)
      if (rosterEntry) {
        result.matched.push({
          zoomName: participant.name,
          canvasUserId: rosterEntry.userId,
          canvasName: rosterEntry.name,
          duration: participant.duration,
          source: 'map',
        })
        continue
      }
      // Map entry points to user not in roster — fall through
    }

    // Clean participant name: strip pronoun-like tokens, e.g. "(he/him)"
    const cleanedParticipant = stripPronouns(participant.name)
    const cleanedLower = cleanedParticipant.toLowerCase()

    // Step 2: Exact case-insensitive match on name or sortableName
    const exactMatch = roster.find(
      (r) =>
        r.name.toLowerCase() === cleanedLower ||
        r.sortableName.toLowerCase() === cleanedLower
    )
    if (exactMatch) {
      result.matched.push({
        zoomName: participant.name,
        canvasUserId: exactMatch.userId,
        canvasName: exactMatch.name,
        duration: participant.duration,
        source: 'exact',
      })
      continue
    }

    // Step 3: Fuzzy Levenshtein matching (full-string + part-to-part)
    // Compute distances for all roster entries in a single pass.
    // Store both bestDistance (part-aware) and fullStringDistance (tiebreaker).
    type Candidate = { canvasName: string; canvasUserId: number; distance: number; fullStringDistance: number }
    const candidates: Candidate[] = []
    const distantCandidates: Candidate[] = []

    for (const entry of roster) {
      const entryNameLower = entry.name.toLowerCase()
      const entrySortableLower = entry.sortableName.toLowerCase()
      const distName = bestDistance(cleanedLower, entryNameLower)
      const distSortable = bestDistance(cleanedLower, entrySortableLower)
      const bestDist = Math.min(distName, distSortable)
      const fullDist = Math.min(
        normalizedDistance(cleanedLower, entryNameLower),
        normalizedDistance(cleanedLower, entrySortableLower),
      )
      const candidate = { canvasName: entry.name, canvasUserId: entry.userId, distance: bestDist, fullStringDistance: fullDist }

      if (bestDist < AMBIGUOUS_CEILING) {
        candidates.push(candidate)
      } else if (bestDist < UNMATCHED_CANDIDATE_CEILING) {
        distantCandidates.push(candidate)
      }
    }
    distantCandidates.sort((a, b) => a.distance - b.distance)

    // Sort candidates by distance (best first), then by fullStringDistance as tiebreaker
    candidates.sort((a, b) => a.distance - b.distance || a.fullStringDistance - b.fullStringDistance)

    if (candidates.length > 0 && candidates[0].distance < AUTO_MATCH_THRESHOLD) {
      // Confidence margin: #1 must beat #2 by MIN_CONFIDENCE_MARGIN.
      // Otherwise the match is too close to call — route to review.
      if (candidates.length > 1) {
        const gap = candidates[1].distance - candidates[0].distance
        if (gap < MIN_CONFIDENCE_MARGIN) {
          result.ambiguous.push({
            zoomName: participant.name,
            duration: participant.duration,
            candidates: stripInternalFields(candidates),
          })
          continue
        }
      }

      const best = candidates[0]
      result.matched.push({
        zoomName: participant.name,
        canvasUserId: best.canvasUserId,
        canvasName: best.canvasName,
        duration: participant.duration,
        source: 'fuzzy',
      })
      if (onAutoMatch) onAutoMatch(participant.name, best.canvasUserId)
      continue
    }

    if (candidates.length > 0) {
      // Ambiguous — candidates exist but none below auto-match threshold
      result.ambiguous.push({
        zoomName: participant.name,
        duration: participant.duration,
        candidates: stripInternalFields(candidates),
      })
      continue
    }

    // Step 4: Unmatched — include nearest candidates (if any) for review
    result.unmatched.push({
      zoomName: participant.name,
      duration: participant.duration,
      candidates: distantCandidates.length > 0 ? stripInternalFields(distantCandidates) : undefined,
    })
  }

  return result
}

/**
 * Strip parenthesized tokens containing a forward slash (e.g. "(he/him)").
 * Splits on whitespace, removes matching tokens, and rejoins.
 */
export function stripPronouns(name: string): string {
  return name
    .split(/\s+/)
    .filter((token) => !PRONOUN_PATTERN.test(token))
    .join(' ')
    .trim()
}

/**
 * Compute the best normalized Levenshtein distance between two name strings.
 *
 * Algorithm:
 *   1. Always compute full-string distance.
 *   2. If either side has only one part (after filtering parts by
 *      MIN_PART_LENGTH), use the single-part mode: min of all
 *      part-to-part distances. This preserves the "Steve matches
 *      Steve Johnson" behavior for one-part Zoom aliases.
 *   3. If both sides have two or more parts, use greedy pairwise
 *      assignment: repeatedly pick the lowest-distance (a_part, b_part)
 *      pair, mark them consumed, continue until one side is exhausted.
 *      Return the AVERAGE of the matched pairs. This ensures that
 *      multi-part names must match on multiple parts — "John Smith"
 *      no longer auto-matches "John Adams" on shared first name alone.
 *   4. Return the minimum of full-string and part-based distance.
 *
 * Both inputs should already be lowercased.
 */
export function bestDistance(a: string, b: string): number {
  const fullDist = normalizedDistance(a, b)

  const partsA = a.split(/\s+/).filter((p) => p.length >= MIN_PART_LENGTH)
  const partsB = b.split(/\s+/).filter((p) => p.length >= MIN_PART_LENGTH)

  if (partsA.length === 0 || partsB.length === 0) {
    return fullDist
  }

  if (partsA.length === 1 || partsB.length === 1) {
    // Single-part mode: min of all pair distances (used for Zoom aliases
    // like "steve" matching canonical "Steve Johnson")
    let best = fullDist
    for (const pa of partsA) {
      for (const pb of partsB) {
        const d = normalizedDistance(pa, pb)
        if (d < best) best = d
      }
    }
    return best
  }

  // Multi-part on both sides: greedy pairwise assignment
  const usedA = new Array<boolean>(partsA.length).fill(false)
  const usedB = new Array<boolean>(partsB.length).fill(false)
  const pairs: number[] = []
  const pairCount = Math.min(partsA.length, partsB.length)

  for (let k = 0; k < pairCount; k++) {
    let bestDist = Infinity
    let bestI = -1
    let bestJ = -1
    for (let i = 0; i < partsA.length; i++) {
      if (usedA[i]) continue
      for (let j = 0; j < partsB.length; j++) {
        if (usedB[j]) continue
        const d = normalizedDistance(partsA[i], partsB[j])
        if (d < bestDist) {
          bestDist = d
          bestI = i
          bestJ = j
        }
      }
    }
    if (bestI < 0 || bestJ < 0) break
    usedA[bestI] = true
    usedB[bestJ] = true
    pairs.push(bestDist)
  }

  const pairwiseAvg = pairs.reduce((s, d) => s + d, 0) / pairs.length
  return Math.min(fullDist, pairwiseAvg)
}

/** Strip internal-only fields (fullStringDistance) from candidates before returning in results. */
function stripInternalFields(
  candidates: Array<{ canvasName: string; canvasUserId: number; distance: number; fullStringDistance: number }>
): Array<{ canvasName: string; canvasUserId: number; distance: number }> {
  return candidates.map(({ canvasName, canvasUserId, distance }) => ({ canvasName, canvasUserId, distance }))
}

/** Compute normalized Levenshtein distance: editDistance / max(a.length, b.length). */
function normalizedDistance(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 0
  return levenshtein(a, b) / maxLen
}
