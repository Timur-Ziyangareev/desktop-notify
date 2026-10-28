/**
 * Host half of `desktop-notify`.
 *
 * The browser half does all the work; this entry exists because the client
 * module table is built from the Host loader's entries: a package only gets
 * its `client.js` served to the page when a row mounts it.
 */

export const name = 'desktop-notify';

export function apply() {
  // Nothing runs on the Host side: the sound and the toast belong to the page.
}
