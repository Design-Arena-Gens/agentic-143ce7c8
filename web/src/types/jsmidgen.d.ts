declare module "jsmidgen" {
  class Track {
    constructor();
    setTempo(tempo: number): void;
    setInstrument(channel: number, instrument: number): void;
    noteOn(
      channel: number,
      note: string,
      delta: number,
      velocity?: number,
    ): void;
    noteOff(
      channel: number,
      note: string,
      delta: number,
      velocity?: number,
    ): void;
  }

  class File {
    constructor();
    addTrack(track: Track): void;
    toBytes(): string;
  }

  export { Track, File };
}
