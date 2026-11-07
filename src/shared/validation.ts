import { AppError } from './errors';

/** Collects every problem with an input so the user sees them all at once, then throws one VALIDATION error. */
export class Problems {
  private readonly list: string[] = [];

  require(condition: boolean, message: string): void {
    if (!condition) this.list.push(message);
  }

  get any(): boolean {
    return this.list.length > 0;
  }

  throwIfAny(): void {
    if (this.list.length) throw new AppError('VALIDATION', this.list.join('; '), { problems: [...this.list] });
  }
}
