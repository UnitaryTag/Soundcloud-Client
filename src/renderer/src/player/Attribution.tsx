import type { TrackSummary } from '@shared/sc'

/**
 * ToS §08 requires apps that stream User Content to credit the uploader, credit
 * SoundCloud as the source, and link back to the sound's page on soundcloud.com.
 * That makes this a compliance requirement rather than a design choice, which
 * is why it sits beside the transport controls rather than in a menu.
 *
 * The link goes through `shell:openExternal`, which enforces an https +
 * SoundCloud-host allowlist — never a raw anchor, which would navigate the app
 * window itself.
 */
export default function Attribution({ track }: { track: TrackSummary }) {
  const open = (): void => {
    if (track.permalinkUrl !== '') void window.sc.shell.openExternal(track.permalinkUrl)
  }

  return (
    <span className="attribution">
      <span className="track-artist">{track.user.username}</span>
      <span className="muted"> on </span>
      {track.permalinkUrl === '' ? (
        <span className="muted">SoundCloud</span>
      ) : (
        <button type="button" className="link" onClick={open}>
          SoundCloud
        </button>
      )}
    </span>
  )
}
