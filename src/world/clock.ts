/** 現実の1秒で進む村の分数（等速時） */
export const MINUTES_PER_SECOND = 2;

export class Clock {
  /** 1日目 0:00 からの経過分 */
  minutes: number;
  speed = 1;

  constructor(startMinutes = 6 * 60) {
    this.minutes = startMinutes;
  }

  /** 現実の経過秒を、村で進む分数に換算する */
  scaledDelta(realSeconds: number, speed = this.speed): number {
    return realSeconds * MINUTES_PER_SECOND * speed;
  }

  get day(): number {
    return Math.floor(this.minutes / 1440) + 1;
  }

  /** 0〜24 の小数で表した時刻 */
  get hourOfDay(): number {
    return (this.minutes % 1440) / 60;
  }

  format(): string {
    const m = Math.floor(this.minutes % 1440);
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return `${this.day}日目 ${hh}:${mm}`;
  }

  formatTime(): string {
    return this.format().split(' ')[1];
  }
}
