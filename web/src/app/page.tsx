'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "classnames";
import type { PolySynth, Synth as ToneSynth, MonoSynth, FMSynth } from "tone";
import type { File as MidiFileType, Track as MidiTrackType } from "jsmidgen";
import {
  NOTE_NAMES,
  TOTAL_STEPS,
  createEmptyPattern,
  type InstrumentId,
  type TrackPattern,
} from "@/lib/music";
import {
  INSTRUMENTS,
  type InstrumentDefinition,
  getInstrument,
} from "@/lib/instruments";

type ToneModule = typeof import("tone");

type MidiModule = {
  File: typeof MidiFileType;
  Track: typeof MidiTrackType;
};

interface TrackState {
  id: string;
  name: string;
  instrument: InstrumentId;
  pattern: TrackPattern;
  volume: number;
  muted: boolean;
}

interface SelectedCell {
  trackId: string;
  row: number;
  step: number;
}

interface SequencerEvent {
  step: number;
  durationSteps: number;
  note: string;
  velocity: number;
}

const instrumentPrograms: Record<InstrumentId, number> = {
  "dream-pad": 89,
  chiptune: 81,
  "fm-keys": 6,
  bass: 34,
};

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const createTrack = (index: number): TrackState => ({
  id: createId(),
  name: `Track ${index + 1}`,
  instrument: INSTRUMENTS[index % INSTRUMENTS.length]?.id ?? "dream-pad",
  pattern: createEmptyPattern(),
  volume: -8,
  muted: false,
});

const stepToTransportTime = (step: number) => {
  const STEPS_PER_BAR = 16;
  const stepsPerBeat = 4;
  const measure = Math.floor(step / STEPS_PER_BAR);
  const remainder = step % STEPS_PER_BAR;
  const beat = Math.floor(remainder / stepsPerBeat);
  const subdivision = remainder % stepsPerBeat;
  return `${measure}:${beat}:${subdivision}`;
};

const noteLabelToMidi = (label: string) =>
  label.toLowerCase().replace("#", "#");

const extractTrackEvents = (pattern: TrackPattern): SequencerEvent[] => {
  const events: SequencerEvent[] = [];

  pattern.forEach((row, rowIndex) => {
    let step = 0;
    while (step < row.length) {
      const cell = row[step];
      if (!cell.active) {
        step += 1;
        continue;
      }
      let length = 1;
      while (
        step + length < row.length &&
        pattern[rowIndex][step + length].active
      ) {
        length += 1;
      }
      events.push({
        step,
        durationSteps: length,
        note: NOTE_NAMES[rowIndex],
        velocity: cell.velocity ?? 0.8,
      });
      step += length;
    }
  });

  return events;
};

const buildInstrument = (
  Tone: ToneModule,
  instrument: InstrumentId,
): PolySynth | ToneSynth | MonoSynth | FMSynth => {
  switch (instrument) {
    case "dream-pad":
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: {
          attack: 0.6,
          decay: 0.4,
          sustain: 0.8,
          release: 1.8,
        },
      }).toDestination();
    case "chiptune":
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "square" },
        envelope: {
          attack: 0.01,
          decay: 0.2,
          sustain: 0.3,
          release: 0.2,
        },
      }).toDestination();
    case "fm-keys":
      return new Tone.FMSynth({
        harmonicity: 3,
        modulationIndex: 10,
        modulation: { type: "triangle" },
        envelope: {
          attack: 0.01,
          decay: 0.3,
          sustain: 0.6,
          release: 1.5,
        },
        modulationEnvelope: {
          attack: 0.2,
          decay: 0.2,
          sustain: 0.2,
          release: 1.0,
        },
      }).toDestination();
    case "bass":
      return new Tone.MonoSynth({
        oscillator: { type: "sawtooth" },
        filter: {
          type: "lowpass",
          Q: 1,
          rolloff: -12,
        },
        envelope: {
          attack: 0.02,
          decay: 0.25,
          sustain: 0.5,
          release: 0.5,
        },
        filterEnvelope: {
          attack: 0.01,
          decay: 0.3,
          sustain: 0.1,
          release: 0.2,
          baseFrequency: 60,
          octaves: 4,
        },
      }).toDestination();
    default:
      return new Tone.Synth().toDestination();
  }
};

export default function Home() {
  const [tracks, setTracks] = useState<TrackState[]>(() => [createTrack(0)]);
  const [tempo, setTempo] = useState(122);
  const [swing, setSwing] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [status, setStatus] = useState<string>("");

  const toneRef = useRef<{
    Tone: ToneModule | null;
    parts: import("tone").Part<any>[];
    synths: Map<string, PolySynth | ToneSynth | MonoSynth | FMSynth>;
  }>({
    Tone: null,
    parts: [],
    synths: new Map(),
  });

  const midiRef = useRef<MidiModule | null>(null);

  useEffect(() => {
    let cancelled = false;

    import("tone")
      .then((Tone) => {
        if (cancelled) return;
        toneRef.current.Tone = Tone;
        Tone.Transport.loop = true;
      })
      .catch(() => {
        setStatus("Failed to load audio engine.");
      });

    import("jsmidgen")
      .then((module) => {
        if (cancelled) return;
        midiRef.current = {
          File: module.File,
          Track: module.Track,
        };
      })
      .catch(() => {
        setStatus("Failed to load MIDI exporter.");
      });

    return () => {
      cancelled = true;
      cleanupAudio();
    };
  }, []);

  const ensureTone = useCallback(async () => {
    if (toneRef.current.Tone) return toneRef.current.Tone;
    const Tone = await import("tone");
    toneRef.current.Tone = Tone;
    return Tone;
  }, []);

  const cleanupAudio = () => {
    toneRef.current.parts.forEach((part) => part.dispose());
    toneRef.current.parts = [];
    toneRef.current.synths.forEach((synth) => synth.dispose());
    toneRef.current.synths.clear();
    const Tone = toneRef.current.Tone;
    if (Tone) {
      Tone.Transport.stop();
      Tone.Transport.cancel(0);
      Tone.Transport.position = 0;
    }
  };

  const toggleCell = (
    trackId: string,
    row: number,
    step: number,
    forceState?: boolean,
  ) => {
    setTracks((prev) =>
      prev.map((track) => {
        if (track.id !== trackId) return track;
        const pattern = track.pattern.map((noteRow, rowIdx) =>
          noteRow.map((cell, stepIdx) => {
            if (rowIdx !== row || stepIdx !== step) return cell;
            const nextActive = forceState ?? !cell.active;
            const velocity = nextActive
              ? cell.velocity ?? 0.8
              : cell.velocity ?? 0.8;
            return {
              ...cell,
              active: nextActive,
              velocity,
            };
          }),
        );
        return { ...track, pattern };
      }),
    );
  };

  const updateTrack = (
    trackId: string,
    updater: (track: TrackState) => TrackState,
  ) => {
    setTracks((prev) =>
      prev.map((track) => (track.id === trackId ? updater(track) : track)),
    );
  };

  const setupPlayback = useCallback(
    async (keepTransportRunning = false) => {
      try {
        const Tone = await ensureTone();
        await Tone.start();

        const loopBars = Math.ceil(TOTAL_STEPS / 16);

      Tone.Transport.bpm.value = tempo;
      Tone.Transport.swing = swing / 100;
      Tone.Transport.swingSubdivision = "8n";
      Tone.Transport.loopEnd = `${loopBars}m`;
      Tone.Transport.loop = true;

      toneRef.current.parts.forEach((part) => part.dispose());
      toneRef.current.parts = [];
      toneRef.current.synths.forEach((synth) => synth.dispose());
      toneRef.current.synths.clear();

      tracks.forEach((track) => {
        if (track.muted) return;
        const synth = buildInstrument(Tone, track.instrument);
        synth.volume.value = track.volume;
        toneRef.current.synths.set(track.id, synth);

        const events = extractTrackEvents(track.pattern);
        if (!events.length) return;

        const part = new Tone.Part(
          (time, value) => {
            const event = value as SequencerEvent;
            const durationSeconds =
              Tone.Time("16n").toSeconds() * event.durationSteps;
            synth.triggerAttackRelease(
              event.note,
              durationSeconds,
              time,
              event.velocity,
            );
          },
          events.map(
            (event) => [stepToTransportTime(event.step), event] as [
              string,
              SequencerEvent,
            ],
          ),
        );

        part.loop = true;
        part.loopEnd = `${loopBars}m`;
        part.start(0);
        toneRef.current.parts.push(part);
      });

        if (!keepTransportRunning) {
          Tone.Transport.position = 0;
          Tone.Transport.start("+0.02");
        }
      } catch (error) {
        console.error(error);
        setStatus(
          "Unable to initialize playback. Check browser audio permissions.",
        );
        setIsPlaying(false);
      }
    },
    [ensureTone, swing, tempo, tracks],
  );

  useEffect(() => {
    if (!isPlaying) return;
    void setupPlayback(true);
  }, [isPlaying, setupPlayback]);

  const startPlayback = async () => {
    if (isPlaying) return;
    await setupPlayback(false);
    setIsPlaying(true);
    setStatus("Playing");
  };

  const stopPlayback = () => {
    const Tone = toneRef.current.Tone;
    if (Tone) {
      Tone.Transport.stop();
      Tone.Transport.position = 0;
    }
    toneRef.current.parts.forEach((part) => part.dispose());
    toneRef.current.parts = [];
    toneRef.current.synths.forEach((synth) => synth.dispose());
    toneRef.current.synths.clear();
    setIsPlaying(false);
    setStatus("Stopped");
  };

  const handleExportMidi = () => {
    if (!midiRef.current) {
      setStatus("MIDI exporter not ready yet.");
      return;
    }
    const { File: MidiFile, Track: MidiTrack } = midiRef.current;
    const file = new MidiFile();
    const ticksPerBeat = 128;
    const ticksPerStep = ticksPerBeat / 4;

    tracks.forEach((track, index) => {
      const midiTrack = new MidiTrack();
      if (index === 0) {
        midiTrack.setTempo(tempo);
      }
      midiTrack.setInstrument(0, instrumentPrograms[track.instrument] ?? 89);

      const events = extractTrackEvents(track.pattern).flatMap((event) => {
        const startTick = event.step * ticksPerStep;
        const durationTicks = event.durationSteps * ticksPerStep;
        return [
          {
            tick: startTick,
            type: "on" as const,
            note: event.note,
            velocity: Math.round(event.velocity * 127),
          },
          {
            tick: startTick + durationTicks,
            type: "off" as const,
            note: event.note,
            velocity: 0,
          },
        ];
      });

      events.sort((a, b) => {
        if (a.tick === b.tick) {
          if (a.type === b.type) return 0;
          return a.type === "off" ? -1 : 1;
        }
        return a.tick - b.tick;
      });

      let lastTick = 0;
      events.forEach((event) => {
        const delta = event.tick - lastTick;
        if (event.type === "on") {
          midiTrack.noteOn(
            0,
            noteLabelToMidi(event.note),
            delta,
            event.velocity,
          );
        } else {
          midiTrack.noteOff(
            0,
            noteLabelToMidi(event.note),
            delta,
            event.velocity,
          );
        }
        lastTick = event.tick;
      });

      file.addTrack(midiTrack);
    });

    const midiBytes = file.toBytes();
    const buffer = new Uint8Array(midiBytes.length);
    for (let index = 0; index < midiBytes.length; index += 1) {
      buffer[index] = midiBytes.charCodeAt(index);
    }

    const blob = new Blob([buffer], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `agentic-sequencer-${Date.now()}.mid`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setStatus("Exported MIDI file.");
  };

  const addTrack = () => {
    setTracks((prev) => [...prev, createTrack(prev.length)]);
  };

  const removeTrack = (trackId: string) => {
    setTracks((prev) => prev.filter((track) => track.id !== trackId));
    setSelectedCell((prev) =>
      prev && prev.trackId === trackId ? null : prev,
    );
  };

  const selectedNote = useMemo(() => {
    if (!selectedCell) return null;
    const track = tracks.find((item) => item.id === selectedCell.trackId);
    if (!track) return null;
    const cell = track.pattern[selectedCell.row]?.[selectedCell.step];
    if (!cell || !cell.active) return null;
    return {
      ...cell,
      note: NOTE_NAMES[selectedCell.row],
      track,
    };
  }, [selectedCell, tracks]);

  const handleVelocityChange = (value: number) => {
    if (!selectedCell) return;
    updateTrack(selectedCell.trackId, (track) => {
      const pattern = track.pattern.map((row, rowIdx) =>
        row.map((cell, stepIdx) => {
          if (rowIdx === selectedCell.row && stepIdx === selectedCell.step) {
            return { ...cell, velocity: value };
          }
          return cell;
        }),
      );
      return { ...track, pattern };
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 pb-24 text-slate-50">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-4 rounded-3xl border border-slate-800/80 bg-slate-900/60 px-8 py-6 shadow-2xl shadow-slate-950/40 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              Agentic MIDI Lab
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              Sketch beats and melodies, jam in the browser, and export polished
              MIDI clips.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={isPlaying ? stopPlayback : startPlayback}
              className={clsx(
                "flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                isPlaying
                  ? "bg-red-500 text-white hover:bg-red-400 focus-visible:outline-red-300"
                  : "bg-emerald-500 text-white hover:bg-emerald-400 focus-visible:outline-emerald-300",
              )}
            >
              <span
                className={clsx(
                  "h-2.5 w-2.5 rounded-full",
                  isPlaying ? "bg-white" : "bg-white animate-pulse",
                )}
              />
              {isPlaying ? "Stop" : "Play"}
            </button>
            <button
              onClick={handleExportMidi}
              className="rounded-full border border-slate-700/70 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-emerald-500/70 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
            >
              Export MIDI
            </button>
            <button
              onClick={addTrack}
              className="rounded-full border border-transparent bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              Add Track
            </button>
          </div>
        </header>

        <section className="grid gap-6 rounded-3xl border border-slate-800/60 bg-slate-900/50 p-6 shadow-2xl shadow-slate-950/40 md:grid-cols-[minmax(0,1fr)_260px]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-3 text-sm font-medium text-slate-200">
                Tempo
                <input
                  type="range"
                  min={70}
                  max={180}
                  value={tempo}
                  onChange={(event) => setTempo(Number(event.target.value))}
                  className="h-1 w-40 accent-emerald-400"
                />
                <span className="w-10 text-right text-sm font-semibold text-white">
                  {tempo}
                </span>
              </label>
              <label className="flex items-center gap-3 text-sm font-medium text-slate-200">
                Swing
                <input
                  type="range"
                  min={0}
                  max={60}
                  value={swing}
                  onChange={(event) => setSwing(Number(event.target.value))}
                  className="h-1 w-32 accent-emerald-400"
                />
                <span className="w-8 text-right text-sm font-semibold text-white">
                  {swing}%
                </span>
              </label>
              <span className="text-xs text-slate-400">{status}</span>
            </div>

            <div className="grid gap-5">
              {tracks.map((track, index) => (
                <TrackCard
                  key={track.id}
                  track={track}
                  index={index}
                  isSolo={tracks.length === 1}
                  selectedCell={selectedCell}
                  onToggleCell={toggleCell}
                  onSelectCell={setSelectedCell}
                  onUpdateTrack={updateTrack}
                  onRemoveTrack={removeTrack}
                />
              ))}
            </div>
          </div>

          <aside className="flex flex-col gap-4 rounded-2xl border border-slate-800/70 bg-slate-950/40 p-5">
            <h2 className="text-lg font-semibold text-white">Inspector</h2>
            {selectedNote ? (
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Track
                  </p>
                  <p className="text-base font-semibold text-white">
                    {selectedNote.track.name}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Note
                  </p>
                  <p className="text-base font-semibold text-emerald-300">
                    {selectedNote.note}
                  </p>
                </div>
                <label className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
                  Velocity
                  <input
                    type="range"
                    min={10}
                    max={127}
                    value={Math.round(selectedNote.velocity * 127)}
                    onChange={(event) =>
                      handleVelocityChange(Number(event.target.value) / 127)
                    }
                    className="h-1 flex-1 accent-emerald-400"
                  />
                  <span className="w-10 text-right text-sm font-semibold text-white">
                    {Math.round(selectedNote.velocity * 127)}
                  </span>
                </label>
                <p className="text-xs text-slate-400">
                  Tip: click any cell and drag the slider to refine how hard the
                  note hits. Double-click a cell to clear it.
                </p>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-800/80 bg-slate-900/30 p-6 text-center text-sm text-slate-400">
                Click on a note to fine-tune its velocity and details.
              </div>
            )}
          </aside>
        </section>
      </main>
    </div>
  );
}

interface TrackCardProps {
  track: TrackState;
  index: number;
  isSolo: boolean;
  selectedCell: SelectedCell | null;
  onToggleCell: (
    trackId: string,
    row: number,
    step: number,
    forceState?: boolean,
  ) => void;
  onSelectCell: (cell: SelectedCell | null) => void;
  onUpdateTrack: (
    trackId: string,
    updater: (track: TrackState) => TrackState,
  ) => void;
  onRemoveTrack: (trackId: string) => void;
}

const TrackCard = ({
  track,
  index,
  isSolo,
  selectedCell,
  onToggleCell,
  onSelectCell,
  onUpdateTrack,
  onRemoveTrack,
}: TrackCardProps) => {
  const stepNumbers = useMemo(() => [...Array(TOTAL_STEPS).keys()], []);

  const currentInstrument = useMemo<InstrumentDefinition>(
    () => getInstrument(track.instrument),
    [track.instrument],
  );

  const handleNameChange = (value: string) => {
    onUpdateTrack(track.id, (current) => ({ ...current, name: value }));
  };

  const handleInstrumentChange = (value: InstrumentId) => {
    onUpdateTrack(track.id, (current) => ({ ...current, instrument: value }));
  };

  const handleVolumeChange = (value: number) => {
    onUpdateTrack(track.id, (current) => ({ ...current, volume: value }));
  };

  const handleMuteToggle = () => {
    onUpdateTrack(track.id, (current) => ({ ...current, muted: !current.muted }));
  };

  const handleClearTrack = () => {
    onUpdateTrack(track.id, (current) => ({
      ...current,
      pattern: createEmptyPattern(),
    }));
  };

  const isCellSelected = (row: number, step: number) =>
    selectedCell?.trackId === track.id &&
    selectedCell.row === row &&
    selectedCell.step === step;

  const handleCellInteraction = (row: number, step: number) => {
    const cell = track.pattern[row][step];
    const nextActive = !cell.active;
    onToggleCell(track.id, row, step, nextActive);
    onSelectCell(
      nextActive ? { trackId: track.id, row, step } : null,
    );
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-slate-800/70 bg-slate-950/30 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-300">
              Track {index + 1}
            </span>
            {!isSolo && (
              <button
                onClick={() => onRemoveTrack(track.id)}
                className="text-xs font-medium text-slate-500 transition hover:text-red-400"
              >
                Remove
              </button>
            )}
          </div>
          <input
            value={track.name}
            onChange={(event) => handleNameChange(event.target.value)}
            className="w-full rounded-xl border border-slate-700/70 bg-slate-900 px-3 py-2 text-base font-semibold text-white outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-500/20 md:w-72"
          />
          <p className="text-sm text-slate-400">
            {currentInstrument.description}
          </p>
        </div>
        <div className="flex flex-col gap-3 text-sm text-slate-200 md:items-end">
          <label className="flex items-center gap-3">
            Instrument
            <select
              value={track.instrument}
              onChange={(event) =>
                handleInstrumentChange(event.target.value as InstrumentId)
              }
              className="rounded-lg border border-slate-700/70 bg-slate-900 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-500/20"
            >
              {INSTRUMENTS.map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-3">
            Volume
            <input
              type="range"
              min={-24}
              max={6}
              value={track.volume}
              onChange={(event) => handleVolumeChange(Number(event.target.value))}
              className="h-1 w-40 accent-emerald-400"
            />
            <span className="w-14 text-right text-sm font-semibold text-white">
              {track.volume} dB
            </span>
          </label>
          <button
            onClick={handleMuteToggle}
            className={clsx(
              "rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide transition",
              track.muted
                ? "border-red-500/60 bg-red-500/10 text-red-300"
                : "border-slate-700/70 bg-slate-900 text-slate-300 hover:border-emerald-400/60 hover:text-emerald-300",
            )}
          >
            {track.muted ? "Muted" : "Mute"}
          </button>
          <button
            onClick={handleClearTrack}
            className="text-xs font-semibold text-slate-400 transition hover:text-slate-200"
          >
            Clear Pattern
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-800/70 bg-slate-950/40">
        <div
          className="min-w-[960px] border-t border-slate-800/60 text-xs"
          style={{
            display: "grid",
            gridTemplateColumns: `80px repeat(${TOTAL_STEPS}, minmax(40px, 1fr))`,
          }}
        >
          <div className="sticky left-0 z-20 border-r border-slate-800/70 bg-slate-950/60 px-3 py-2 text-left font-semibold uppercase text-slate-400">
            Note
          </div>
          {stepNumbers.map((step) => (
            <div
              key={`head-${step}`}
              className={clsx(
                "flex items-center justify-center border-r border-slate-900/40 bg-slate-950/30 py-2 font-semibold text-slate-500",
                step % 4 === 0 && "bg-slate-900/60 text-white",
              )}
            >
              {step + 1}
            </div>
          ))}

          {NOTE_NAMES.map((note, rowIdx) => (
            <div key={`row-${note}`} className="contents">
              <div className="sticky left-0 z-10 border-y border-r border-slate-800/70 bg-slate-950/80 px-3 py-2 text-sm font-semibold text-slate-300">
                {note}
              </div>
              {track.pattern[rowIdx].map((cell, stepIdx) => {
                const isBarBoundary = stepIdx % 16 === 0;
                const isBeat = stepIdx % 4 === 0;
                const active = cell.active;
                return (
                  <button
                    key={`${note}-${stepIdx}`}
                    onClick={() => handleCellInteraction(rowIdx, stepIdx)}
                    onDoubleClick={() => {
                      onToggleCell(track.id, rowIdx, stepIdx, false);
                      onSelectCell(null);
                    }}
                    className={clsx(
                      "relative flex h-10 items-center justify-center border-r border-b border-slate-900/40 transition",
                      active
                        ? "bg-gradient-to-br from-emerald-400/80 via-emerald-500/60 to-emerald-600/70 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]"
                        : "bg-slate-950/20 hover:bg-slate-900/40",
                      isCellSelected(rowIdx, stepIdx) &&
                        "ring-2 ring-emerald-300/80 ring-offset-1 ring-offset-slate-950",
                      isBarBoundary && "border-l border-slate-700/70",
                      !isBeat && "bg-slate-950/10",
                    )}
                  >
                    {active && (
                      <span className="absolute inset-x-2 bottom-1 block h-1 rounded-full bg-white/70" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
