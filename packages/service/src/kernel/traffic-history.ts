import type { TrafficSample } from "../../../contracts/src/index";
export class TrafficHistory {
  private previous?: { at: number; upload: number; download: number };
  readonly points: TrafficSample[] = [];
  sample(at: number, upload: number, download: number): TrafficSample {
    const p = this.previous;
    const elapsed = p ? (at - p.at) / 1000 : 0;
    const valid =
      p &&
      elapsed > 0 &&
      elapsed <= 5 &&
      upload >= p.upload &&
      download >= p.download;
    const point = {
      at,
      uploadRate: valid ? (upload - p.upload) / elapsed : null,
      downloadRate: valid ? (download - p.download) / elapsed : null,
    };
    this.previous = { at, upload, download };
    this.points.push(point);
    while (this.points.length > 600 || this.points[0].at < at - 600000)
      this.points.shift();
    return point;
  }
  reset() {
    this.previous = undefined;
    this.points.length = 0;
  }
}
