// HD voice: lift the Opus caps in the SDP. The *receiver's* fmtp limits what the sender may use,
// so this must run on BOTH sides (offer and answer), after tuneSdp():
//
//   OfferPage:   setLocalDescription({ type: 'offer',  sdp: hdAudioSdp(tuneSdp(offer.sdp ?? '')) })
//   ReceivePage: setLocalDescription({ type: 'answer', sdp: hdAudioSdp(tuneSdp(answer.sdp ?? '')) })

const WANT: Record<string, string> = {
  stereo: '0', // voice is mono: all bits go to one channel
  'sprop-stereo': '0',
  maxaveragebitrate: '128000', // was 32 kbps
  maxplaybackrate: '48000', // full-band
  'sprop-maxcapturerate': '48000',
  useinbandfec: '1',
  usedtx: '0', // DTX makes quiet speech choppy
  cbr: '0'
};

export function hdAudioSdp(sdp: string): string {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const line = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);

  if (line.test(sdp)) {
    return sdp.replace(line, (_all, params: string) => {
      const kv = new Map<string, string>();
      for (const p of params
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const i = p.indexOf('=');
        kv.set(i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1));
      }
      for (const [k, v] of Object.entries(WANT)) kv.set(k, v);
      return `a=fmtp:${pt} ${[...kv].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')}`;
    });
  }
  // no fmtp line yet: add one right after the rtpmap line
  const add = Object.entries(WANT)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${add}`);
}
