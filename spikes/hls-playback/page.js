import { IpcLoader } from '/loader.js'

// Surface the stack — an unhandled rejection alone just says "undefined".
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  console.log(`unhandled rejection: ${reason?.stack ?? String(reason)}`)
})
window.addEventListener('error', (event) => {
  console.log(`window error: ${event.error?.stack ?? event.message}`)
})

const audio = document.getElementById('player')
const readyStates = []
let settled = false

const finish = (payload) => {
  if (settled) return
  settled = true
  void window.spike.report(payload)
}

const hls = new Hls({
  // The production loader, bundled unchanged from src/.
  loader: IpcLoader,
  debug: false
})

hls.on(Hls.Events.ERROR, (_event, data) => {
  console.log(`hls error: ${data.type} fatal=${data.fatal} ${data.details}`)
  if (data.fatal) {
    finish({
      error: `${data.type}/${data.details}`,
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyStates: readyStates.join(' ')
    })
  }
})

hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
  console.log(`fragment loaded: ${data.frag.url.split('/').pop()}`)
})

audio.addEventListener('playing', () => console.log('audio: playing'))
audio.addEventListener('waiting', () => console.log('audio: waiting'))

const sample = setInterval(() => {
  readyStates.push(`${audio.readyState}@${audio.currentTime.toFixed(1)}`)
}, 1000)

// Absolute, because the loader hands this straight to the main process and a
// relative URL has no origin to resolve against there. In production the URL
// comes from SoundCloud's API and is always absolute.
hls.loadSource(`${location.origin}/media/stream.m3u8`)
hls.attachMedia(audio)

hls.on(Hls.Events.MANIFEST_PARSED, () => {
  audio.play().catch((cause) => console.log(`play() rejected: ${cause.message}`))
})

setTimeout(() => {
  clearInterval(sample)
  finish({
    currentTime: audio.currentTime,
    duration: audio.duration,
    readyStates: readyStates.join(' ')
  })
}, 12000)
