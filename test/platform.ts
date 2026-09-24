/**
 * Runs the action with `process.platform` reporting `win32`, so the Windows
 * branches (case-insensitive path folding, ...) execute on a Linux/macOS test
 * host too; the real value is restored afterwards, even when the action throws.
 */
export async function onWin32<T>(action: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}
