// SPDX-License-Identifier: Apache-2.0

/**
 * The one place an engine's numbers become this program's numbers —
 * [#70](https://github.com/openzigs/onyourleft/issues/70).
 *
 * #70's sixth criterion: *"every engine response is validated before use; a
 * malformed or partial response produces a typed error, never a route with
 * `NaN` distance rendered as a real route."*
 *
 * ⚠️ **Here rather than in the adapter, and that is the point.** An adapter
 * knows one engine's JSON shape; the rule that a distance must be a finite
 * non-negative number is not about any engine at all. Putting the check beside
 * the fetch would mean writing it again for the second engine #70 requires, and
 * the second copy is the one that would be a little weaker. So the adapter's
 * job ends at "pull the fields out of whatever this engine calls them", and
 * every value crosses into the program through this file.
 *
 * ⚠️ **The branding constructors are doing most of the work, and they throw a
 * `UnitError`, not a `RoutingError`.** `degreesLatitude` refuses a `NaN` and
 * anything outside [-90, 90]; `metres` refuses a negative distance. Letting
 * those escape would break {@link RoutingProvider}'s promise that only a
 * `RoutingError` comes out of it — so each is caught and re-raised with the
 * leg that produced it. The unit error's own message is deliberately **not**
 * carried through: ADR 0004 decision D forbids naming a coordinate's value, and
 * `UnitError` for a latitude names the field and the constraint precisely so a
 * caller can pass it on, but the leg index is the more useful diagnostic here
 * and it cannot leak a location.
 */

import { degreesLatitude, degreesLongitude, geographicPosition, metres } from '../quantities';
import { altitudeMetres } from '../quantities';
import type { GeographicPosition, Metres } from '../quantities';
import { RoutingError } from './errors';
import type {
  ElevationDataset,
  HeightProfile,
  HeightSample,
  RoutedLeg,
  SurfaceKind,
} from './provider';

/** A coordinate as an engine reported it, before anything believes it. */
export interface RawPosition {
  readonly latitude: number;
  readonly longitude: number;
}

/** One leg as an engine reported it. */
export interface RawLeg {
  readonly shape: readonly RawPosition[];
  readonly distance: number;
  /** Whatever the engine called the surface. Anything unrecognised is `'unknown'`. */
  readonly surface: string | undefined;
}

/** One height sample as an engine reported it. `null` is a void; see {@link HeightSample}. */
export interface RawHeight {
  readonly along: number;
  readonly elevation: number | null | undefined;
}

/**
 * The fewest points a leg can have and still be a leg: **two**.
 *
 * One point is not a path, and an engine that answers with one has answered
 * with something this program cannot draw, measure or ride. #71's first
 * criterion asserts a *snapped* leg has substantially more than two — this is
 * only the floor below which there is nothing at all.
 */
export const MINIMUM_LEG_POINTS = 2;

/**
 * A bound on the geometry one leg may return: **20 000 points**.
 *
 * Untrusted input in the sense CLAUDE.md §6 means it: the response comes from a
 * service over the network, and a leg that decodes to a million points is a
 * frozen tab rather than a long route. Twenty thousand at ADR 0010 D-5's 30 m
 * source resolution is 600 km of geometry in a single leg between two
 * waypoints, which is far past anything a rider draws by hand.
 */
export const MAXIMUM_LEG_POINTS = 20_000;

export function checkedLeg(raw: RawLeg, leg: number): RoutedLeg {
  if (raw.shape.length < MINIMUM_LEG_POINTS) {
    throw new RoutingError(
      'malformed-response',
      `leg ${String(leg + 1)} came back with ${String(raw.shape.length)} points; a leg needs at least ${String(MINIMUM_LEG_POINTS)}`,
      leg,
    );
  }
  if (raw.shape.length > MAXIMUM_LEG_POINTS) {
    throw new RoutingError(
      'malformed-response',
      `leg ${String(leg + 1)} came back with ${String(raw.shape.length)} points; the most this client will draw is ${String(MAXIMUM_LEG_POINTS)}`,
      leg,
    );
  }
  return {
    shape: raw.shape.map((point) => checkedPosition(point, leg)),
    distance: checkedDistance(raw.distance, leg),
    surface: surfaceFrom(raw.surface),
  };
}

/**
 * What the engine's surface word maps to.
 *
 * ⚠️ **Anything unrecognised is `'unknown'`, and `'unknown'` is never
 * `'paved'`.** #72: *"a leg with unknown surface is labelled unknown rather
 * than assumed paved. Assuming paved is how a road bike ends up on a gravel
 * track."* An engine that grows a new surface word therefore degrades to
 * honest ignorance rather than to a confident wrong answer.
 */
export function surfaceFrom(word: string | undefined): SurfaceKind {
  if (word === 'paved') return 'paved';
  if (word === 'unpaved') return 'unpaved';
  return 'unknown';
}

export function checkedHeights(source: ElevationDataset, raw: readonly RawHeight[]): HeightProfile {
  const samples: HeightSample[] = [];
  let previous = -Infinity;
  for (const [index, sample] of raw.entries()) {
    const along = checkedDistance(sample.along, undefined);
    // ⚠️ Monotonic, and checked rather than assumed. Every consumer of this
    // profile walks it forward — #72 sums ascent across it and the chart plots
    // distance on the x axis — so a series that goes backwards produces a
    // negative step that reads as a descent and a chart that folds over itself.
    if (along <= previous && index > 0) {
      throw new RoutingError(
        'malformed-response',
        `the elevation series does not advance: sample ${String(index + 1)} is not further along than the one before it`,
      );
    }
    previous = along;
    samples.push({
      along,
      elevation:
        sample.elevation === null || sample.elevation === undefined
          ? undefined
          : checkedElevation(sample.elevation),
    });
  }
  return { source, samples };
}

function checkedPosition(raw: RawPosition, leg: number): GeographicPosition {
  try {
    return geographicPosition(degreesLatitude(raw.latitude), degreesLongitude(raw.longitude));
  } catch {
    // Deliberately no value in the message — ADR 0004 decision D. The leg is
    // the diagnostic a rider can act on; the coordinate is their address.
    throw new RoutingError(
      'malformed-response',
      `leg ${String(leg + 1)} came back with a coordinate that is not a position on Earth`,
      leg,
    );
  }
}

function checkedDistance(value: number, leg: number | undefined): Metres {
  try {
    return metres(value);
  } catch {
    const where = leg === undefined ? 'the elevation series' : `leg ${String(leg + 1)}`;
    throw new RoutingError(
      'malformed-response',
      `${where} came back with a distance that is not a finite number of metres`,
      leg,
    );
  }
}

function checkedElevation(value: number): ReturnType<typeof altitudeMetres> {
  try {
    return altitudeMetres(value);
  } catch {
    throw new RoutingError(
      'malformed-response',
      'the elevation series came back with a height that is not a finite number of metres',
    );
  }
}
