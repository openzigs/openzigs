"use client";

import { useRef, useEffect, useCallback } from "react";
import type { EffectsState } from "@/components/music-studio/EffectsRack";

const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

interface AudioNodes {
  eqFilters: BiquadFilterNode[];
  panNode: StereoPannerNode;
  compressorNode: DynamicsCompressorNode;
  distortionNode: WaveShaperNode;
  reverbGain: GainNode;
  dryGain: GainNode;
  reverbConvolver: ConvolverNode;
  masterGain: GainNode;
}

/** Generate a simple impulse response buffer for reverb. */
function createImpulseResponse(
  ctx: AudioContext,
  duration: number = 2.0,
  decay: number = 2.0,
): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

/** Build a distortion curve for WaveShaperNode. */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const k = amount * 5;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = k === 0 ? x : ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/**
 * Hook that builds a real-time Web Audio effects chain and
 * updates its parameters whenever `effects` changes.
 *
 * Chain: source → EQ → Pan → Compressor → Distortion → [Dry+Reverb] → masterGain → destination
 *
 * Returns a `connect(sourceNode)` callback the caller should
 * invoke once their MediaElementSourceNode is ready.
 */
export function useAudioEffectsChain(
  audioContext: AudioContext | null,
  effects: EffectsState,
) {
  const nodesRef = useRef<AudioNodes | null>(null);
  const connectedSourceRef = useRef<AudioNode | null>(null);

  // Build node graph once when audioContext becomes available
  useEffect(() => {
    if (!audioContext) return;
    if (nodesRef.current) return; // already built

    const eqFilters = EQ_FREQUENCIES.map((freq, i) => {
      const filter = audioContext.createBiquadFilter();
      filter.type = i === 0 ? "lowshelf" : i === EQ_FREQUENCIES.length - 1 ? "highshelf" : "peaking";
      filter.frequency.value = freq;
      filter.Q.value = 1.4;
      filter.gain.value = 0;
      return filter;
    });

    // Chain EQ filters together
    for (let i = 0; i < eqFilters.length - 1; i++) {
      eqFilters[i].connect(eqFilters[i + 1]);
    }

    const panNode = audioContext.createStereoPanner();
    const compressorNode = audioContext.createDynamicsCompressor();
    compressorNode.threshold.value = -24;
    compressorNode.knee.value = 30;
    compressorNode.ratio.value = 4;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.25;

    const distortionNode = audioContext.createWaveShaper();
    distortionNode.oversample = "4x";

    const dryGain = audioContext.createGain();
    const reverbGain = audioContext.createGain();
    const reverbConvolver = audioContext.createConvolver();
    reverbConvolver.buffer = createImpulseResponse(audioContext);

    const masterGain = audioContext.createGain();

    // Wire: lastEQ → pan → compressor → distortion → split(dry / reverb) → master → dest
    const lastEq = eqFilters[eqFilters.length - 1];
    lastEq.connect(panNode);
    panNode.connect(compressorNode);
    compressorNode.connect(distortionNode);

    distortionNode.connect(dryGain);
    distortionNode.connect(reverbConvolver);
    reverbConvolver.connect(reverbGain);

    dryGain.connect(masterGain);
    reverbGain.connect(masterGain);
    masterGain.connect(audioContext.destination);

    nodesRef.current = {
      eqFilters,
      panNode,
      compressorNode,
      distortionNode,
      dryGain,
      reverbGain,
      reverbConvolver,
      masterGain,
    };

    return () => {
      // Tear down on unmount
      try {
        masterGain.disconnect();
        dryGain.disconnect();
        reverbGain.disconnect();
        reverbConvolver.disconnect();
        distortionNode.disconnect();
        compressorNode.disconnect();
        panNode.disconnect();
        eqFilters.forEach((f) => f.disconnect());
        connectedSourceRef.current?.disconnect();
      } catch {
        // already disconnected
      }
      nodesRef.current = null;
      connectedSourceRef.current = null;
    };
  }, [audioContext]);

  // Update parameters whenever effects change
  useEffect(() => {
    const nodes = nodesRef.current;
    if (!nodes) return;

    // EQ gains
    nodes.eqFilters.forEach((filter, i) => {
      filter.gain.value = effects.eqGains[i] ?? 0;
    });

    // Stereo pan
    nodes.panNode.pan.value = effects.stereoPosition;

    // Compressor bypass via ratio
    if (effects.compressorEnabled) {
      nodes.compressorNode.ratio.value = 4;
    } else {
      nodes.compressorNode.ratio.value = 1; // effectively bypass
    }

    // Distortion
    if (effects.distortionAmount > 0) {
      nodes.distortionNode.curve = makeDistortionCurve(effects.distortionAmount);
    } else {
      nodes.distortionNode.curve = null;
    }

    // Reverb wet/dry
    nodes.dryGain.gain.value = 1 - effects.reverbMix;
    nodes.reverbGain.gain.value = effects.reverbMix;
  }, [effects]);

  /** Connect a source node into the chain. */
  const connectSource = useCallback(
    (source: AudioNode) => {
      const nodes = nodesRef.current;
      if (!nodes) return;

      // Disconnect any previous source
      if (connectedSourceRef.current) {
        try {
          connectedSourceRef.current.disconnect();
        } catch {
          // already disconnected
        }
      }

      source.connect(nodes.eqFilters[0]);
      connectedSourceRef.current = source;
    },
    []
  );

  return { connectSource, isReady: !!nodesRef.current };
}
