import { describe, it, expect } from 'vitest'
import { matchAttendance, stripPronouns, bestDistance } from '../../../src/attendance/name-matcher.js'
import { ZoomNameMap } from '../../../src/attendance/zoom-name-map.js'
import type { ZoomParticipant, RosterEntry } from '../../../src/attendance/types.js'

describe('matchAttendance', () => {
  const roster: RosterEntry[] = [
    { userId: 1, name: 'Jane Smith', sortableName: 'Smith, Jane' },
    { userId: 2, name: 'John Smith', sortableName: 'Smith, John' },
    { userId: 3, name: 'Alice Johnson', sortableName: 'Johnson, Alice' },
    { userId: 4, name: 'Bob Williams', sortableName: 'Williams, Bob' },
  ]

  it('(1) persistent map hit — known mapping matches immediately', () => {
    const nameMap = new ZoomNameMap()
    nameMap.set('jsmith_zoom', 1)

    const participants: ZoomParticipant[] = [
      { name: 'jsmith_zoom', originalName: null, duration: 45 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]).toEqual({
      zoomName: 'jsmith_zoom',
      canvasUserId: 1,
      canvasName: 'Jane Smith',
      duration: 45,
      source: 'map',
    })
    expect(result.ambiguous).toHaveLength(0)
    expect(result.unmatched).toHaveLength(0)
  })

  it('(2) exact case-insensitive match on name field', () => {
    const nameMap = new ZoomNameMap()
    const participants: ZoomParticipant[] = [
      { name: 'jane smith', originalName: null, duration: 50 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]).toEqual({
      zoomName: 'jane smith',
      canvasUserId: 1,
      canvasName: 'Jane Smith',
      duration: 50,
      source: 'exact',
    })
  })

  it('(3) exact match on sortableName field', () => {
    const nameMap = new ZoomNameMap()
    const participants: ZoomParticipant[] = [
      { name: 'Smith, Jane', originalName: null, duration: 55 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]).toEqual({
      zoomName: 'Smith, Jane',
      canvasUserId: 1,
      canvasName: 'Jane Smith',
      duration: 55,
      source: 'exact',
    })
  })

  it('(4) high-confidence fuzzy match — auto-matches with distance < 0.33', () => {
    const nameMap = new ZoomNameMap()
    // "Jane Smth" vs "Jane Smith" -- edit distance 1, max length 10 => 0.1
    const participants: ZoomParticipant[] = [
      { name: 'Jane Smth', originalName: null, duration: 40 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]).toEqual({
      zoomName: 'Jane Smth',
      canvasUserId: 1,
      canvasName: 'Jane Smith',
      duration: 40,
      source: 'fuzzy',
    })
    // High-confidence fuzzy match should be auto-saved to nameMap
    expect(nameMap.get('Jane Smth')).toBe(1)
  })

  it('(5) ambiguous fuzzy match — distance between 0.33 and 0.5', () => {
    const nameMap = new ZoomNameMap()
    // Use a name that is moderately close to multiple roster entries
    // but not close enough to any single one to auto-match.
    // "Jxxx Smithson" — full string is distant, part "Smithson" vs "Smith" = 3/8 = 0.375
    const participants: ZoomParticipant[] = [
      { name: 'Jxxx Smithson', originalName: null, duration: 30 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(1)
    expect(result.ambiguous[0].zoomName).toBe('Jxxx Smithson')
    expect(result.ambiguous[0].duration).toBe(30)
    expect(result.ambiguous[0].candidates.length).toBeGreaterThanOrEqual(1)
    // All candidates should have distance between 0.33 and 0.5
    for (const c of result.ambiguous[0].candidates) {
      expect(c.distance).toBeGreaterThanOrEqual(0.33)
      expect(c.distance).toBeLessThan(0.5)
    }
  })

  it('(6) unmatched name — no close match, but includes distant candidates', () => {
    const nameMap = new ZoomNameMap()
    const participants: ZoomParticipant[] = [
      { name: 'xyz123', originalName: null, duration: 20 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].zoomName).toBe('xyz123')
    expect(result.unmatched[0].duration).toBe(20)
    // Distant candidates should be included for the review file
    expect(result.unmatched[0].candidates).toBeDefined()
    expect(result.unmatched[0].candidates!.length).toBeGreaterThan(0)
    // All candidates should have distance >= 0.5
    for (const c of result.unmatched[0].candidates!) {
      expect(c.distance).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('(7) persistent map entry for user not in roster — falls through to fuzzy', () => {
    const nameMap = new ZoomNameMap()
    // Map points to userId 999 which is not in roster
    nameMap.set('Jane Smth', 999)

    const participants: ZoomParticipant[] = [
      { name: 'Jane Smth', originalName: null, duration: 35 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    // Should NOT match via map (user 999 not in roster)
    // Should fall through to fuzzy and match "Jane Smith" (distance ~0.1)
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].canvasUserId).toBe(1)
    expect(result.matched[0].source).toBe('fuzzy')
  })

  it('(8) empty participants list — returns empty result', () => {
    const nameMap = new ZoomNameMap()
    const result = matchAttendance([], roster, nameMap)

    expect(result.matched).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(0)
    expect(result.unmatched).toHaveLength(0)
  })

  it('(9) empty roster — all participants unmatched', () => {
    const nameMap = new ZoomNameMap()
    const participants: ZoomParticipant[] = [
      { name: 'Jane Smith', originalName: null, duration: 50 },
      { name: 'John Smith', originalName: null, duration: 45 },
    ]

    const result = matchAttendance(participants, [], nameMap)

    expect(result.matched).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(0)
    expect(result.unmatched).toHaveLength(2)
  })

  it('(10) pronoun suffix stripped — exact match after removing "(he/him)"', () => {
    const nameMap = new ZoomNameMap()
    const participants: ZoomParticipant[] = [
      { name: 'Jane Smith (she/her)', originalName: null, duration: 50 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].canvasUserId).toBe(1)
    expect(result.matched[0].source).toBe('exact')
  })

  it('(11) parenthesized token without slash is kept — tiebreaker resolves via full-string distance', () => {
    const nameMap = new ZoomNameMap()
    const participants: ZoomParticipant[] = [
      { name: 'Jane (Jenny) Smith', originalName: null, duration: 50 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    // "(Jenny)" lacks a slash so it's kept — won't exact-match "Jane Smith".
    // Part matching "Smith" ties between "Jane Smith" and "John Smith" (both distance 0),
    // but full-string tiebreaker resolves: "jane (jenny) smith" is closer to "jane smith"
    // than to "john smith", so Jane Smith wins.
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].canvasUserId).toBe(1)
    expect(result.matched[0].canvasName).toBe('Jane Smith')
    expect(result.matched[0].source).toBe('fuzzy')
  })

  it('(12) part-to-part matching — first name only matches via parts', () => {
    const nameMap = new ZoomNameMap()
    // "Alice" alone: full-string distance to "Alice Johnson" is high,
    // but part "Alice" vs "Alice" = 0
    const participants: ZoomParticipant[] = [
      { name: 'Alice', originalName: null, duration: 40 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].canvasUserId).toBe(3)
    expect(result.matched[0].canvasName).toBe('Alice Johnson')
    expect(result.matched[0].source).toBe('fuzzy')
  })

  it('(13) tied fuzzy match is ambiguous — "Smith" matches multiple roster entries equally', () => {
    const nameMap = new ZoomNameMap()
    // "Smith" matches part "Smith" in both "Jane Smith" and "John Smith" at distance 0
    const participants: ZoomParticipant[] = [
      { name: 'Smith', originalName: null, duration: 30 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    expect(result.matched).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(1)
    expect(result.ambiguous[0].zoomName).toBe('Smith')
    // Should have at least 2 candidates tied at the same distance
    expect(result.ambiguous[0].candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('(14) "J. Smith" matches via part-to-part — "Smith" vs "Smith" = 0', () => {
    const nameMap = new ZoomNameMap()
    const participants: ZoomParticipant[] = [
      { name: 'J. Smith', originalName: null, duration: 30 },
    ]

    const result = matchAttendance(participants, roster, nameMap)

    // "Smith" part matches exactly against both Jane Smith and John Smith,
    // so this becomes ambiguous (two candidates at distance 0)
    // or matches the first one — either way, it should not be unmatched
    expect(result.unmatched).toHaveLength(0)
  })
})

describe('stripPronouns', () => {
  it('removes (he/him) suffix', () => {
    expect(stripPronouns('John Smith (he/him)')).toBe('John Smith')
  })

  it('removes (she/her) suffix', () => {
    expect(stripPronouns('Jane Smith (she/her)')).toBe('Jane Smith')
  })

  it('removes (they/them) suffix', () => {
    expect(stripPronouns('Alex Jones (they/them)')).toBe('Alex Jones')
  })

  it('removes (she/they) mixed pronouns', () => {
    expect(stripPronouns('Sam Lee (she/they)')).toBe('Sam Lee')
  })

  it('keeps parenthesized tokens without slash — potential nicknames', () => {
    expect(stripPronouns('Jane (Jenny) Smith')).toBe('Jane (Jenny) Smith')
  })

  it('keeps plain names unchanged', () => {
    expect(stripPronouns('Jane Smith')).toBe('Jane Smith')
  })

  it('handles multiple pronoun tokens', () => {
    expect(stripPronouns('Name (he/him) (they/them)')).toBe('Name')
  })
})

describe('bestDistance', () => {
  it('full-string match returns 0', () => {
    expect(bestDistance('jane smith', 'jane smith')).toBe(0)
  })

  it('part match beats full-string distance', () => {
    // "alice" vs "alice johnson" — full string is 0.615, but part "alice" vs "alice" = 0
    const full = bestDistance('alice', 'alice johnson')
    expect(full).toBe(0)
  })

  it('skips short tokens (< 3 chars) in part comparison', () => {
    // "jo" vs "john smith" — "jo" is too short for part comparison
    // so only full-string distance is used
    const d = bestDistance('jo', 'john smith')
    expect(d).toBeGreaterThan(0.5)
  })

  it('returns best part-to-part distance for multi-part names', () => {
    // "jane smth" vs "jane smith" — part "jane" vs "jane" = 0
    const d = bestDistance('jane smth', 'jane smith')
    expect(d).toBe(0)
  })
})
