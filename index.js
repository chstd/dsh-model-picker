/**
 * dsh-model-picker, host half.
 *
 * The bundle is pure Client work: the Host already owns the model catalog and
 * the `session.selectModel` mutation, and the browser half renders over the
 * shared per-session model directory. This half exists only so the bundle has
 * a Loader row and a valid `exports["."]` target.
 */
export function apply() {}
