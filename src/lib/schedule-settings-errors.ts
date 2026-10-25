/**
 * Do not silently replace persisted scheduling policy with defaults when a
 * settings query fails, and do not report a schedule update as saved when the
 * database rejected it.
 */
function describeScheduleSettingsError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "database operation failed");
  }
  return String(error);
}

export function requireScheduleSettingsRead<T>(
  data: T | null | undefined,
  error: unknown,
): T | null {
  if (error) {
    throw new Error(
      `Schedule configuration read failed: ${describeScheduleSettingsError(error)}`,
    );
  }
  return data ?? null;
}

export function assertScheduleSettingsWrite(error: unknown): void {
  if (error) {
    throw new Error(
      `Schedule configuration write failed: ${describeScheduleSettingsError(error)}`,
    );
  }
}
