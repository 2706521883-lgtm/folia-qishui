/**
 * Rejects when `promise` has not settled within `timeoutMs`.
 *
 * The timer is always cleared when the promise settles, so a fast response never leaves a stray
 * timer behind. Passing a non-positive timeout returns the original promise unchanged.
 */
export class TimeoutError extends Error {
    constructor(label = 'Operation') {
        super(`${label} timed out`);
        this.name = 'TimeoutError';
    }
}

export const isTimeoutError = (error: unknown): error is TimeoutError => error instanceof TimeoutError;

export const withTimeout = <T>(
    promise: Promise<T>,
    timeoutMs: number,
    label = 'Operation',
): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(label)), timeoutMs);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
};
