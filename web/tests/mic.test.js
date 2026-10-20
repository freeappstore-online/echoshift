import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
let dom;
let getUserMedia;
let source;

beforeEach(() => {
  dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://echoshift.freeappstore.online/' });
  const { window } = dom;
  source = { connect: vi.fn(), disconnect: vi.fn() };
  window.__testAudioContext = { createMediaStreamSource: vi.fn(() => source) };
  window.eval('ensureAudioContext = () => window.__testAudioContext; state.inputGainNode = {}');
  getUserMedia = vi.fn();
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
});

afterEach(() => dom.window.close());

function openMic() {
  const { document } = dom.window;
  document.getElementById('tabBtnMic').click();
  document.getElementById('btnMic').click();
  return document;
}

function stream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], track };
}

describe('root index.html microphone', () => {
  it('switches to the microphone panel when its tab is clicked', () => {
    const { document } = dom.window;
    document.getElementById('tabBtnMic').click();
    expect(document.getElementById('panelMic').classList.contains('active')).toBe(true);
    expect(document.getElementById('panelSpoken').classList.contains('active')).toBe(false);
  });

  it('requests the microphone only after Enable Microphone is clicked', async () => {
    const media = stream();
    getUserMedia.mockResolvedValue(media);
    const { document } = dom.window;
    document.getElementById('tabBtnMic').click();
    expect(getUserMedia).not.toHaveBeenCalled();
    document.getElementById('btnMic').click();
    await vi.waitFor(() => expect(document.getElementById('btnMicLabel').textContent).toBe('Mute Microphone'));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(source.connect).toHaveBeenCalled();
  });

  it.each([
    ['NotAllowedError', 'Microphone permission blocked'],
    ['NotFoundError', 'No microphone detected'],
  ])('shows a useful message for %s', async (name, message) => {
    getUserMedia.mockRejectedValue({ name });
    const document = openMic();
    await vi.waitFor(() => expect(document.getElementById('noticeText').textContent).toContain(message));
  });

  it('identifies a policy block even when getUserMedia reports NotAllowedError', async () => {
    Object.defineProperty(dom.window.document, 'permissionsPolicy', {
      configurable: true,
      value: { allowsFeature: vi.fn(() => false) },
    });
    getUserMedia.mockRejectedValue({ name: 'NotAllowedError' });
    const document = openMic();
    await vi.waitFor(() => expect(document.getElementById('noticeText').textContent).toContain('hosting policy'));
  });

  it('stops every track and disconnects the source when leaving the mic tab', async () => {
    const media = stream();
    getUserMedia.mockResolvedValue(media);
    const document = openMic();
    await vi.waitFor(() => expect(document.getElementById('btnMicLabel').textContent).toBe('Mute Microphone'));
    document.getElementById('tabBtnUpload').click();
    expect(media.track.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(document.getElementById('btnMicLabel').textContent).toBe('Enable Microphone');
  });

  it('stops a stream returned after the user leaves the mic tab', async () => {
    let resolveStream;
    getUserMedia.mockReturnValue(new Promise(resolve => { resolveStream = resolve; }));
    const document = openMic();
    document.getElementById('tabBtnUpload').click();
    const media = stream();
    resolveStream(media);
    await vi.waitFor(() => expect(media.track.stop).toHaveBeenCalledOnce());
    expect(source.connect).not.toHaveBeenCalled();
  });
});
