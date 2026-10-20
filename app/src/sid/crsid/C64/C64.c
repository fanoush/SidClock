
//C64 emulation (SID-playback related)


#include "../libcRSID.h"

/* Optional section/optimisation attributes for the hottest functions.
 * The FLPR blob links them into the VPR's own SRAM (code fetched from
 * RRAM costs ~3 cycles/instruction on that core, from SRAM ~1 - see
 * docs/flpr.md); empty for the M33 build and for RISC-V builds without
 * the blob.
 *
 * CRSID_HOT_CODE forces size optimisation (the SRAM window is limited
 * and the function is large); CRSID_HOT_CODE_SPEED keeps the file's
 * -O2 because the 6510 interpreter is the hottest loop there is. */
#ifndef CRSID_HOT_CODE
#define CRSID_HOT_CODE
#endif
#ifndef CRSID_HOT_CODE_SPEED
#define CRSID_HOT_CODE_SPEED CRSID_HOT_CODE
#endif

#include "MEM.c"
#include "CPU.c"
#include "CIA.c"
#include "VIC.c"
#include "SID.c"

#include "C64_SIDrouting.c"

#ifdef CRSID_SPLIT
/* Split mode: local SID instances (used outside split mode; in split mode
 * the same five live in FLPR SRAM so the blob touches them locally). The
 * blob must carry no writable globals (see flpr/linker.ld), so it gets a
 * constant "always split" flag instead of the variable. */
#ifndef FLPR_BLOB
static cRSID_SIDinstance cRSID_SIDlocal[CRSID_SIDCOUNT_MAX+1];
char cRSID_splitMode; /* 1 = split engine: blob runs the CPU, M33 the SID */
#endif
#endif

extern int sid_frame_calls; //device debug counter (play-routine frames since boot); defined by the app shim (or test harness)


cRSID_C64instance* cRSID_createC64 (unsigned short samplerate) { //init a basic PAL C64 instance
 //static cRSID_C64instance* C64 = &cRSID_C64;

 //enum C64clocks { C64_PAL_CPUCLK=985248, DEFAULT_SAMPLERATE=44100 };
 static enum { VOLUME_MAX=0xF, CHANNELS=3+1, SID_FULLVOLUME = (CHANNELS*VOLUME_MAX) /*64*/ } SIDspecs; //digi-channel is counted too in attenuation

 if(samplerate) cRSID_C64.SampleRate = samplerate;
 else cRSID_C64.SampleRate = samplerate = CRSID_DEFAULT_SAMPLERATE;
 cRSID_C64.SampleClockRatio = (CRSID_PAL_CPUCLK << CRSID_CLOCK_FRACTIONAL_BITS) / samplerate; //shifting (multiplication) enhances SampleClockRatio precision
 cRSID_C64.OversampleClockRatio = (samplerate << CRSID_RESAMPLER_FRACTIONAL_BITS) / CRSID_PAL_AUDIO_CLOCK; //round( SID_AUDIO_CLOCK / C64->SampleRate );
 cRSID_C64.OversampleClockRatioReciproc = CRSID_PAL_AUDIO_CLOCK / cRSID_C64.SampleRate; //round?

#if defined(CRSID_SPLIT) && !defined(FLPR_BLOB)
 cRSID_C64.SID = cRSID_SIDlocal;
#endif
 cRSID_C64.SIDchipCount=cRSID_C64.AudioThread_SIDchipCount=1; //init audio-thread's version as well
 cRSID_C64.Attenuation = ((SID_FULLVOLUME+26) * CRSID_PRESAT_ATT_NOM) / (CRSID_PRESAT_ATT_DENOM * CRSID_WAVGEN_PREDIV);
 //cRSID_C64.CPU.C64 = C64;
 cRSID_createSIDchip ( &cRSID_C64.SID[1], 8580, CRSID_CHANNEL_BOTH, 0xD400 ); //default C64 setup with only 1 SID and 2 CIAs and 1 VIC
 cRSID_createCIAchip ( &cRSID_C64.CIA[1], 0xDC00 );
 cRSID_createCIAchip ( &cRSID_C64.CIA[2], 0xDD00 );
 cRSID_createVICchip ( 0xD000 );
 cRSID_generateMemoryBankPointers();
 //if(cRSID.RealSIDmode) {
  cRSID_setROMcontent();
 //}
 cRSID_initC64();
 return &cRSID_C64;
}



void cRSID_setSIDmodels () { //based on SIDheader-data
 short SIDmodel;

 SIDmodel = (cRSID.SIDheader->ModelFormatStandard&0x30) >= 0x20 ? 8580:6581;
 cRSID_C64.SID[1].ChipModel = cRSID.SelectedSIDmodel? cRSID.SelectedSIDmodel : SIDmodel;

 if (cRSID.SIDheader->Version != CRSID_FILEVERSION_WEBSID) {
  SIDmodel = cRSID.SIDheader->ModelFormatStandard & 0xC0;
  if (SIDmodel) SIDmodel = (SIDmodel >= 0x80) ? 8580:6581; else SIDmodel = cRSID_C64.SID[1].ChipModel;
  if (cRSID.SelectedSIDmodel) SIDmodel = cRSID.SelectedSIDmodel;
  cRSID_C64.SID[2].ChipModel = SIDmodel;

  SIDmodel = cRSID.SIDheader->ModelFormatStandardH & 0x03;
  if (SIDmodel) SIDmodel = (SIDmodel >= 0x02) ? 8580:6581; else SIDmodel = cRSID_C64.SID[1].ChipModel;
  if (cRSID.SelectedSIDmodel) SIDmodel = cRSID.SelectedSIDmodel;
  cRSID_C64.SID[3].ChipModel = SIDmodel;
 }
 else {
  SIDmodel = cRSID.SIDheader->SID2flagsL & 0x30;
  if (SIDmodel) SIDmodel = (SIDmodel >= 0x20) ? 8580:6581; else SIDmodel = cRSID_C64.SID[1].ChipModel;
  if (cRSID.SelectedSIDmodel) SIDmodel = cRSID.SelectedSIDmodel;
  cRSID_C64.SID[2].ChipModel = SIDmodel;

  SIDmodel = cRSID.SIDheader->SID3flagsL & 0x30;
  if (SIDmodel) SIDmodel = (SIDmodel >= 0x20) ? 8580:6581; else SIDmodel = cRSID_C64.SID[1].ChipModel;
  if (cRSID.SelectedSIDmodel) SIDmodel = cRSID.SelectedSIDmodel;
  cRSID_C64.SID[3].ChipModel = SIDmodel;

  SIDmodel = cRSID.SIDheader->SID4flagsL & 0x30;
  if (SIDmodel) SIDmodel = (SIDmodel >= 0x20) ? 8580:6581; else SIDmodel = cRSID_C64.SID[1].ChipModel;
  if (cRSID.SelectedSIDmodel) SIDmodel = cRSID.SelectedSIDmodel;
  cRSID_C64.SID[4].ChipModel = SIDmodel;
 }
}


void cRSID_setC64 () {   //set hardware-parameters (Models, SIDs) for playback of loaded SID-tune
 //static cRSID_C64instance* C64 = &cRSID_C64;

 //enum C64clocks { C64_PAL_CPUCLK=985248, C64_NTSC_CPUCLK=1022727 };
 enum C64scanlines { C64_PAL_SCANLINES = 312, C64_NTSC_SCANLINES = 263 };
 enum C64scanlineCycles { C64_PAL_SCANLINE_CYCLES = 63, C64_NTSC_SCANLINE_CYCLES = 65 };
 //enum C64framerates { PAL_FRAMERATE = 50, NTSC_FRAMERATE = 60 }; //Hz
 static enum { VOLUME_MAX=0xF, CHANNELS=3+1, SID_FULLVOLUME = (CHANNELS*VOLUME_MAX) /*64*/ } SIDspecs; //digi-channel is counted too in attenuation

 static const unsigned int CPUspeeds[] = { CRSID_NTSC_CPUCLK, CRSID_PAL_CPUCLK };
 static const unsigned short ScanLines[] = { C64_NTSC_SCANLINES, C64_PAL_SCANLINES };
 static const unsigned char ScanLineCycles[] = { C64_NTSC_SCANLINE_CYCLES, C64_PAL_SCANLINE_CYCLES };
 //unsigned char FrameRates[] = { NTSC_FRAMERATE, PAL_FRAMERATE };
 static const short Attenuations[]={ //manually tweaked attenuation, increase for 2SID (to 43) and 3SID (to 137) and 4SID (200)
  ((SID_FULLVOLUME+0  ) * CRSID_PRESAT_ATT_NOM) / (CRSID_PRESAT_ATT_DENOM * CRSID_WAVGEN_PREDIV), //CRSID_WAVGEN_PREDIV compensates for dividing by it in envelope-multiplier
  ((SID_FULLVOLUME+26 ) * CRSID_PRESAT_ATT_NOM) / (CRSID_PRESAT_ATT_DENOM * CRSID_WAVGEN_PREDIV),  //(64+26) =  90  *28/(16*1..16)=157..9
  ((SID_FULLVOLUME+43 ) * CRSID_PRESAT_ATT_NOM) / (CRSID_PRESAT_ATT_DENOM * CRSID_WAVGEN_PREDIV),  //(64+43) = 107  *28/(16*1..16)=187..11
  ((SID_FULLVOLUME+137) * CRSID_PRESAT_ATT_NOM) / (CRSID_PRESAT_ATT_DENOM * CRSID_WAVGEN_PREDIV), //(64+137) = 201  *28/(16*1..16)=351..21
  ((SID_FULLVOLUME+200) * CRSID_PRESAT_ATT_NOM) / (CRSID_PRESAT_ATT_DENOM * CRSID_WAVGEN_PREDIV)  //(64+200) = 264  *28/(16*1..16)=462..28
 };
 /*short SIDmodel;*/ char SIDchannel;

 cRSID.VideoStandard = ( (cRSID.SIDheader->ModelFormatStandard & 0x0C) >> 2 ) != 2;
 if (cRSID_C64.SampleRate==0) cRSID_C64.SampleRate = 44100;
 cRSID_C64.CPUfrequency = CPUspeeds[ cRSID.VideoStandard ];
 cRSID_C64.SampleClockRatio = (cRSID_C64.CPUfrequency << CRSID_CLOCK_FRACTIONAL_BITS) / cRSID_C64.SampleRate; //shifting (multiplication) enhances SampleClockRatio precision
 cRSID_C64.OversampleClockRatio = (cRSID_C64.SampleRate << CRSID_RESAMPLER_FRACTIONAL_BITS) / CRSID_PAL_AUDIO_CLOCK; //round( SID_AUDIO_CLOCK / C64->SampleRate );
 cRSID_C64.OversampleClockRatioReciproc = CRSID_PAL_AUDIO_CLOCK / cRSID_C64.SampleRate; //round?

 cRSID_C64.VIC.RasterLines = ScanLines[ cRSID.VideoStandard ];
 cRSID_C64.VIC.RasterRowCycles = ScanLineCycles[ cRSID.VideoStandard ];
 cRSID.FrameCycles = cRSID_C64.VIC.RasterLines * cRSID_C64.VIC.RasterRowCycles; ///cRSID_C64.SampleRate / PAL_FRAMERATE; //1x speed tune with VIC Vertical-blank timing

 cRSID_C64.PrevRasterLine=-1; //so if $d012 is set once only don't disturb FrameCycleCnt

 cRSID_setSIDmodels();

 if (cRSID.SIDheader->Version != CRSID_FILEVERSION_WEBSID) {
  cRSID_C64.SID[1].Channel = CRSID_CHANNEL_LEFT;

  cRSID_createSIDchip( &cRSID_C64.SID[2], cRSID_C64.SID[2].ChipModel, CRSID_CHANNEL_RIGHT, 0xD000 + cRSID.SIDheader->SID2baseAddress*16 );

  cRSID_createSIDchip( &cRSID_C64.SID[3], cRSID_C64.SID[3].ChipModel, CRSID_CHANNEL_BOTH, 0xD000 + cRSID.SIDheader->SID3baseAddress*16 );

 //ensure disabling SID4 in non-WebSID format:  //(NULL-ing not preferred as it can overwrite stuff and cause Segfault in sample-thread)
  cRSID_C64.SID[4].BaseAddress=0x0000;
  cRSID_C64.SID[4].BasePtr = cRSID_C64.SID[4].BasePtrRD = &cRSID_C64.SIDnullGuard; //slim: no spare bank area, sink never read (BaseAddress==0)

 }
 else {
  cRSID_C64.SID[1].Channel = (cRSID.SIDheader->ModelFormatStandardH & 0x40)? CRSID_CHANNEL_RIGHT:CRSID_CHANNEL_LEFT;
  if (cRSID.SIDheader->ModelFormatStandardH & 0x80) cRSID_C64.SID[1].Channel = CRSID_CHANNEL_BOTH; //my own proposal for 'middle' channel

  SIDchannel = (cRSID.SIDheader->SID2flagsL & 0x40) ? CRSID_CHANNEL_RIGHT:CRSID_CHANNEL_LEFT;
  if (cRSID.SIDheader->SID2flagsL & 0x80) SIDchannel = CRSID_CHANNEL_BOTH;
  cRSID_createSIDchip ( &cRSID_C64.SID[2], cRSID_C64.SID[2].ChipModel, SIDchannel, 0xD000 + cRSID.SIDheader->SID2baseAddress*16 );

  SIDchannel = (cRSID.SIDheader->SID3flagsL & 0x40) ? CRSID_CHANNEL_RIGHT:CRSID_CHANNEL_LEFT;
  if (cRSID.SIDheader->SID3flagsL & 0x80) SIDchannel = CRSID_CHANNEL_BOTH;
  cRSID_createSIDchip ( &cRSID_C64.SID[3], cRSID_C64.SID[3].ChipModel, SIDchannel, 0xD000 + cRSID.SIDheader->SID3flagsH*16 );

  SIDchannel = (cRSID.SIDheader->SID4flagsL & 0x40) ? CRSID_CHANNEL_RIGHT:CRSID_CHANNEL_LEFT;
  if (cRSID.SIDheader->SID4flagsL & 0x80) SIDchannel = CRSID_CHANNEL_BOTH;
  cRSID_createSIDchip ( &cRSID_C64.SID[4], cRSID_C64.SID[4].ChipModel, SIDchannel, 0xD000 + cRSID.SIDheader->SID4baseAddress*16 );
 }

 cRSID_C64.SIDchipCount = 1 + (cRSID_C64.SID[2].BaseAddress > 0) + (cRSID_C64.SID[3].BaseAddress > 0) + (cRSID_C64.SID[4].BaseAddress > 0);
 if (cRSID_C64.SIDchipCount == 1) cRSID_C64.SID[1].Channel = CRSID_CHANNEL_BOTH;
 cRSID_C64.Attenuation = Attenuations[cRSID_C64.SIDchipCount];
}



void cRSID_initC64 () { //C64 Reset
 enum { C64_RESET_VECTOR = 0xFFFC };
 //static cRSID_C64instance* C64 = &cRSID_C64;

 cRSID_initSIDchip( &cRSID_C64.SID[1] );
 cRSID_initCIAchip( &cRSID_C64.CIA[1] ); cRSID_initCIAchip( &cRSID_C64.CIA[2] );
 /*cRSID_setROMcontent();*/ cRSID_initMem();
 cRSID_initCPU( (cRSID_readMem(C64_RESET_VECTOR+1)<<8) + cRSID_readMem(C64_RESET_VECTOR) ); //cRSID_initCPU( &cRSID_C64.CPU, (cRSID_readMemC64(C64,0xFFFD)<<8) + cRSID_readMemC64(C64,0xFFFC) );
 cRSID_C64.IRQ = cRSID_C64.NMI = 0;
 if (cRSID.HighQualitySID) {
  cRSID_C64.SID[1].NonFiltedSample = cRSID_C64.SID[1].FilterInputSample = 0;
  cRSID_C64.SID[2].NonFiltedSample = cRSID_C64.SID[2].FilterInputSample = 0;
  cRSID_C64.SID[3].NonFiltedSample = cRSID_C64.SID[3].FilterInputSample = 0;
  cRSID_C64.SID[4].NonFiltedSample = cRSID_C64.SID[4].FilterInputSample = 0;
  cRSID_C64.SID[1].PrevNonFiltedSample = cRSID_C64.SID[1].PrevFilterInputSample = 0;
  cRSID_C64.SID[2].PrevNonFiltedSample = cRSID_C64.SID[2].PrevFilterInputSample = 0;
  cRSID_C64.SID[3].PrevNonFiltedSample = cRSID_C64.SID[3].PrevFilterInputSample = 0;
  cRSID_C64.SID[4].PrevNonFiltedSample = cRSID_C64.SID[4].PrevFilterInputSample = 0;
 }
 cRSID_C64.SampleCycleCnt = cRSID_C64.OverSampleCycleCnt = 0;
}



#ifdef CRSID_SPLIT_PROF
/* Blob-only split profiling: how many cycles each section takes per
 * audio frame, exponential-averaged (1/16) in shared memory so the M33
 * can log it whenever the debug snapshot is read. The read-modify-write
 * happens once per frame, not per instruction, so it costs well under
 * 1% and does not distort the attribution. */
static inline uint32_t prof_cyc (void) {
 uint32_t v;

 __asm__ volatile ("csrr %0, mcycle" : "=r" (v));
 return v;
}

static inline void prof_ema (volatile uint32_t *dst, uint32_t v) {
 *dst = *dst - (*dst >> 4) + (v >> 4);
}

#define PROF_BEGIN() (prof_t = prof_cyc())
#define PROF_END(slot) do { uint32_t _n = prof_cyc(); (slot) += _n - prof_t; prof_t = _n; } while (0)
#endif

CRSID_HOT_CODE cRSID_Output* cRSID_emulateC64 () {
 //static cRSID_C64instance* C64 = &cRSID_C64;

 //static enum { VOLUME_MAX=0xF, CHANNELS=3+1 } SIDspecs; //digi-channel is counted too in attenuation
 //enum C64clocks { C64_PAL_CPUCLK=985248, DEFAULT_SAMPLERATE=44100 };
 //enum Oversampling { OVERSAMPLING_RATIO=5, OVERSAMPLING_CYCLES = ((C64_PAL_CPUCLK/DEFAULT_SAMPLERATE)/OVERSAMPLING_RATIO) };
 static enum { VUMETER_LOWPASS_DIV = 16, VUMETER_DIVSHIFTS = (4 - CRSID_WAVGEN_PRESHIFT) } VUmeterParameters;

 FASTVAR unsigned char InstructionCycles;
#ifdef CRSID_SPLIT
 unsigned short SplitCycles = 0; //sum of this sample's instruction cycles
#endif
#ifdef CRSID_SPLIT_CPU_SIDE
 /* Cycle offset of the next write inside this sample (see flpr_shared.h):
  * reset here, advanced after every instruction below. A write executes
  * before its instruction's cycles are added, so the value it reads is
  * the instruction's start offset - exactly what the M33's replay needs. */
 if (cRSID_splitMode) FLPR_SPLIT->cur_cyc = 0;
#endif
 static unsigned char VUmeterUpdateCounter;
 static cRSID_Output* Output;
#ifdef CRSID_SPLIT_PROF
 uint32_t prof_cpu = 0, prof_cia = 0, prof_vic = 0;
 uint32_t prof_t = prof_cyc();
#endif


 //Cycle-based/-paced part of emulations:


 while (cRSID_C64.SampleCycleCnt <= cRSID_C64.SampleClockRatio) {

  if ( CALMLY (!cRSID_C64.RealSIDmode) ) {
   if ( RARELY (cRSID_C64.FrameCycleCnt >= cRSID.FrameCycles) ) {
    cRSID_C64.FrameCycleCnt -= cRSID.FrameCycles;
    if ( RARELY (cRSID_C64.Finished) ) { //some tunes (e.g. Barbarian, A-Maze-Ing) don't always finish in 1 frame
     cRSID_initCPU( cRSID.PlayAddress ); //(PSID docs say bank-register should always be set for each call's region)
     cRSID_C64.Finished=0; //cRSID_C64.SampleCycleCnt=0; //PSID workaround for some tunes (e.g. Galdrumway):
     ++sid_frame_calls; //new play-routine call starting (device debug counter)
     if ( LIKELY (cRSID.TimerSource==0) ) cRSID_C64.IObankRD[((0xD019) & 0xFFF)] = 0x81; //always simulate to player-calls that VIC-IRQ happened
     else cRSID_C64.IObankRD[((0xDC0D) & 0xFFF)] = 0x83; //always simulate to player-calls that CIA TIMERA/TIMERB-IRQ happened
   }}
   if ( TIGHTLY (cRSID_C64.Finished==0) ) {
#ifdef CRSID_SPLIT_PROF
    PROF_BEGIN();
#endif
    if ( RARELY ((InstructionCycles = cRSID_emulateCPU()) >= 0xFE) ) { InstructionCycles=6; cRSID_C64.Finished=1; }
#ifdef CRSID_SPLIT_PROF
    PROF_END(prof_cpu);
#endif
   }
   else InstructionCycles=7; //idle between player-calls
   cRSID_C64.FrameCycleCnt += InstructionCycles;
   cRSID_C64.IObankRD[((0xDC04) & 0xFFF)] += InstructionCycles; //very simple CIA1 TimerA simulation for PSID (e.g. Delta-Mix_E-Load_loader)
  }

  else { //RealSID emulations:
#ifdef CRSID_SPLIT_PROF
   PROF_BEGIN();
#endif
   if ( RARELY (cRSID_handleCPUinterrupts()) ) { cRSID_C64.Finished=0; InstructionCycles=7; ++sid_frame_calls; } //IRQ/NMI dispatched (device debug counter)
   else if ( MOSTLY (cRSID_C64.Finished==0) ) {
    if ( RARELY ((InstructionCycles = cRSID_emulateCPU()) >= 0xFE) ) {
     /*if (InstructionCycles!=0xFE && !(cRSID_C64.CPU.ST&I))*/ cRSID_C64.Finished=1;
     InstructionCycles=6;
    }
   }
   else InstructionCycles=7; //idle between IRQ-calls
#ifdef CRSID_SPLIT_PROF
   PROF_END(prof_cpu);
   PROF_BEGIN();
#endif
   cRSID_C64.IRQ = cRSID_C64.NMI = 0; //prepare for collecting IRQ sources
   cRSID_C64.IRQ |= cRSID_emulateCIA( &cRSID_C64.CIA[1], InstructionCycles );
   cRSID_C64.NMI |= cRSID_emulateCIA( &cRSID_C64.CIA[2], InstructionCycles );
#ifdef CRSID_SPLIT_PROF
   PROF_END(prof_cia);
   PROF_BEGIN();
#endif
   cRSID_C64.IRQ |= cRSID_emulateVIC( InstructionCycles );
#ifdef CRSID_SPLIT_PROF
   PROF_END(prof_vic);
#endif
  }

  cRSID_C64.SampleCycleCnt += (InstructionCycles << CRSID_CLOCK_FRACTIONAL_BITS);

#ifdef CRSID_SPLIT
  SplitCycles += InstructionCycles;
#endif
#ifdef CRSID_SPLIT_CPU_SIDE
  if (cRSID_splitMode) FLPR_SPLIT->cur_cyc = SplitCycles;
#endif
#ifdef CRSID_SPLIT_CPU_SIDE
  if (!cRSID_splitMode)
#endif
  {
  //OPT: event-driven envelope stepping (exact upstream window semantics).
  //Per SID the instruction cycles fold into ADSRacc and a pass runs only
  //when they can reach the earliest possible envelope event; SID-register
  //writes force a pass (ADSRthr=0, see CPU.c). Folded calls collapse into
  //the prefix add inside the pass (see SID_ADSR.c).
  { FASTVAR unsigned short acc;
    acc = cRSID_C64.SID[1].ADSRacc + InstructionCycles;
    if ( acc >= cRSID_C64.SID[1].ADSRthr ) { cRSID_emulateADSRs( &cRSID_C64.SID[1], (unsigned short)(acc - InstructionCycles), InstructionCycles ); acc = 0; }
    cRSID_C64.SID[1].ADSRacc = acc;
  }
  if (cRSID_C64.SID[2].BaseAddress != 0) { FASTVAR unsigned short acc;
    acc = cRSID_C64.SID[2].ADSRacc + InstructionCycles;
    if ( acc >= cRSID_C64.SID[2].ADSRthr ) { cRSID_emulateADSRs( &cRSID_C64.SID[2], (unsigned short)(acc - InstructionCycles), InstructionCycles ); acc = 0; }
    cRSID_C64.SID[2].ADSRacc = acc;
  }
  if (cRSID_C64.SID[3].BaseAddress != 0) { FASTVAR unsigned short acc;
    acc = cRSID_C64.SID[3].ADSRacc + InstructionCycles;
    if ( acc >= cRSID_C64.SID[3].ADSRthr ) { cRSID_emulateADSRs( &cRSID_C64.SID[3], (unsigned short)(acc - InstructionCycles), InstructionCycles ); acc = 0; }
    cRSID_C64.SID[3].ADSRacc = acc;
  }
  if (cRSID_C64.SID[4].BaseAddress != 0) { FASTVAR unsigned short acc;
    acc = cRSID_C64.SID[4].ADSRacc + InstructionCycles;
    if ( acc >= cRSID_C64.SID[4].ADSRthr ) { cRSID_emulateADSRs( &cRSID_C64.SID[4], (unsigned short)(acc - InstructionCycles), InstructionCycles ); acc = 0; }
    cRSID_C64.SID[4].ADSRacc = acc;
  }

  }
 } //end of 1MHz cycle-based emulations (CPU, VIC, CIA, ADSR)
#ifdef CRSID_SPLIT_PROF
 { /* per-frame section cycles; prof[3] is everything else in the
    * frame (waveform publish, event handling, loop overhead) */
  uint32_t total = prof_cpu + prof_cia + prof_vic;

  prof_ema(&FLPR_SHARED->prof[0], prof_cpu);
  prof_ema(&FLPR_SHARED->prof[1], prof_cia);
  prof_ema(&FLPR_SHARED->prof[2], prof_vic);
  prof_ema(&FLPR_SHARED->prof[3], total);
  prof_cpu = prof_cia = prof_vic = 0;
 }
#endif
 cRSID_C64.SampleCycleCnt -= cRSID_C64.SampleClockRatio;


#ifdef CRSID_SPLIT_CPU_SIDE
 if ( RARELY (cRSID_splitMode) ) { //CPU side: publish this sample's cycles, no SID
  uint32_t sx = FLPR_SPLIT->prod % FLPR_SID_RING;

  FLPR_SID_CYC[sx] = SplitCycles;
  FLPR_SPLIT->prod = FLPR_SPLIT->prod + 1;
  { static cRSID_Output ZeroOut = {0,0}; return &ZeroOut; }
 }
#endif
 if ( TIGHTLY (cRSID_C64.HighQualitySID) ) { //oversampled waveform-generation (although delayed ~22 cycles (~5 instructions) compared to CPU, shouldn't cause many issues (apart from cycle-exact SID-routines reading OSC3))
  if ( TIGHTLY (cRSID_C64.HighQualityResampler) ) cRSID_emulateHQresampledSIDs(); //high-quality but more CPU-hungry Sinc-based resampler (decimator)
  else cRSID_emulateOversampledSIDwaves(); //fast simple (but lower-quality) averager (box-filter) resampler
 }


 //Samplerate-based/-paced part of emulations:


 if ( CALMLY (!cRSID_C64.RealSIDmode) ) { //some PSID tunes use CIA TOD-clock (e.g. Kawasaki Synthesizer Demo)
  --cRSID_C64.TenthSecondCnt;
  if ( RARELY (cRSID_C64.TenthSecondCnt <= 0) ) {
   cRSID_C64.TenthSecondCnt = cRSID_C64.SampleRate / 10;
   ++( cRSID_C64.IObankRD[((0xDC08) & 0xFFF)] );
   if ( RARELY (cRSID_C64.IObankRD[((0xDC08) & 0xFFF)] >= 10) ) {
    cRSID_C64.IObankRD[((0xDC08) & 0xFFF)] = 0; ++( cRSID_C64.IObankRD[((0xDC09) & 0xFFF)] );
    //if(cRSID_C64.IObankRD[((0xDC09) & 0xFFF)]%
 }}}
 if ( MOSTLY (cRSID_C64.SecondCnt < cRSID_C64.SampleRate) ) ++cRSID_C64.SecondCnt;
 else { cRSID_C64.SecondCnt = 0; if ( MOSTLY (cRSID.PlayTime<3600) ) ++cRSID.PlayTime; }


 if ( TIGHTLY (cRSID_C64.HighQualitySID) ) { //SID output-stages and mono/stereo handling for High-Quality SID-emulation
  Output = TIGHTLY (cRSID_C64.HighQualityResampler) ? cRSID_emulateHQresampledSIDoutputs() : cRSID_emulateOversampledSIDoutputs();
 }
 else Output = cRSID_emulateLightSIDs(); //with special lightweight waveform-antialiasing code

 //Output.L /= cRSID_C64.Attenuation //( (CHANNELS*VOLUME_MAX) + cRSID_C64.Attenuation ); //* cRSID_C64.AudioThread_SIDchipCount;
 //Output.R /= cRSID_C64.Attenuation //( (CHANNELS*VOLUME_MAX) + cRSID_C64.Attenuation ); //* cRSID_C64.AudioThread_SIDchipCount;


 if ( RARELY (!cRSID.CLImode && !++VUmeterUpdateCounter) ) {
  //average level (for VU-meter)
  cRSID_C64.SID[1].Level += ( (abs(cRSID_C64.SID[1].Output)>>VUMETER_DIVSHIFTS) - cRSID_C64.SID[1].Level ) / VUMETER_LOWPASS_DIV; //16; //4; //1024;
  if ( TIGHTLY (cRSID_C64.SID[2].BaseAddress != 0) )
   cRSID_C64.SID[2].Level += ( (abs(cRSID_C64.SID[2].Output)>>VUMETER_DIVSHIFTS) - cRSID_C64.SID[2].Level ) / VUMETER_LOWPASS_DIV; //16; //1024;
  if ( TIGHTLY (cRSID_C64.SID[3].BaseAddress != 0) )
   cRSID_C64.SID[3].Level += ( (abs(cRSID_C64.SID[3].Output)>>VUMETER_DIVSHIFTS) - cRSID_C64.SID[3].Level ) / VUMETER_LOWPASS_DIV; //16; //1024;
  if ( TIGHTLY (cRSID_C64.SID[4].BaseAddress != 0) )
   cRSID_C64.SID[4].Level += ( (abs(cRSID_C64.SID[4].Output)>>VUMETER_DIVSHIFTS) - cRSID_C64.SID[4].Level ) / VUMETER_LOWPASS_DIV; //16; //1024;
 }

 return Output;
}





#ifdef CRSID_SPLIT
/* Relocate the SID instances: the FLPR blob runs the SID stage from its
 * own SRAM in split mode. Reload the tune afterwards so the new
 * instances are created and BasePtr points at the register mirror. */
void cRSID_setSplit (char on) {
#ifdef FLPR_BLOB
 (void)on; /* always split on the blob side */
#else
 if ( (on ? 1 : 0) == cRSID_splitMode ) return;
 cRSID_splitMode = on ? 1 : 0;
 if ( on ) {
  int i;

  /* Split B: the M33 renders the SID stage from its own register copy
   * (the blob's CPU runs ahead and pushes writes as events). One 32-byte
   * block per chip, so clear them all. */
  for (i=0; i<(int)FLPR_SID_REGCOPY_SIZE; ++i) ((volatile unsigned char*)FLPR_SID_REGCOPY)[i] = 0;
  for (i=1; i<=CRSID_SIDCOUNT_MAX; ++i) {
   cRSID_SIDinstance* SID = &cRSID_C64.SID[i];

   if ( SID->BaseAddress ) cRSID_createSIDchip( SID, SID->ChipModel, (char)SID->Channel, SID->BaseAddress );
  }
 }
#endif
}


/* M33 side (split B): render one sample from the blob's cycle count and
 * the SID writes it recorded. Events are applied just before the sample
 * they belong to, so register timing stays within one sample. */
/* Advance the envelope generators by `cycles` (<= 7 per pass, see
 * SID_ADSR.c). The split replays a sample's cycles in order, stopping at
 * each recorded SID write. */
static void cRSID_splitReplayAdsr (unsigned short cycles) {
 int n;

 for (n=1; n<=CRSID_SIDCOUNT_MAX; ++n) {
  cRSID_SIDinstance* SID = &cRSID_C64.SID[n];
  FASTVAR unsigned short left = cycles;

  if (n > 1 && SID->BaseAddress == 0) continue; //unused SID
  /* The ADSR pass expects instruction-sized windows: it detects at most
   * one envelope shot per call and the quiet-voice folding assumes
   * cycles/call <= 7 (< any prescale period). */
  while ( left ) {
   FASTVAR unsigned short acc;
   FASTVAR unsigned char w = (unsigned char)(left > 7 ? 7 : left);

   acc = SID->ADSRacc + w;
   if ( acc >= SID->ADSRthr ) { cRSID_emulateADSRs( SID, (unsigned short)(acc - w), w ); acc = 0; }
   SID->ADSRacc = acc;
   left -= w;
  }
 }
}

int cRSID_renderSplitSample (void) {
 uint32_t s = FLPR_SPLIT->cons;
 unsigned short cyc;
 uint32_t done = 0; //cycles of this sample already replayed
 static cRSID_Output Out;

 if ( FLPR_SPLIT->prod == s ) return 0; //blob has not reached this sample yet
 { uint32_t lead = FLPR_SPLIT->prod - s;

   /* Skip the first second: the blob starts from an empty ring, so the
    * initial fill is not a steady-state margin. */
   if (s > 22050U && lead < FLPR_SPLIT->lead_min) FLPR_SPLIT->lead_min = lead;
 }
 cyc = FLPR_SID_CYC[s % FLPR_SID_RING];

 while ( FLPR_SPLIT->econs != FLPR_SPLIT->eprod ) {
  uint32_t e = FLPR_SPLIT->econs % FLPR_EVENTS_MAX;
  uint32_t at;

  if ( (int32_t)(FLPR_EVENTS[e].pos - s) > 0 ) break; //belongs to a later sample
  /* Replay the cycles before this write first: the envelope must be at
   * the state the CPU saw when it issued it. */
  at = FLPR_EVENTS[e].cyc;
  if (at > cyc) at = cyc;
  if (at > done) { cRSID_splitReplayAdsr((unsigned short)(at - done)); done = at; }
  /* Apply the write to the chip's own 32-byte block (2SID/3SID tunes),
   * then let the envelope pass latch it the way the per-instruction fold
   * does on the unsplit engine: settle the cycles elapsed before the
   * write (a pure fold - what the accumulated ADSRacc stands for), then
   * evaluate the write itself. The CPU side runs ahead, so several
   * writes of this sample are already in the ring; collapsing them into
   * one pass loses a hard restart (gate off then on a few instructions
   * later) and the envelope never restarts - Leviathan did exactly that
   * on every note-on. */
  { uint32_t chip = FLPR_EVENTS[e].chip;
    cRSID_SIDinstance* SID;

    if ( chip < 1U || chip > CRSID_SIDCOUNT_MAX ) chip = 1U;
    ((volatile unsigned char*)FLPR_SID_REGCOPY)[(chip - 1U) * 32U + FLPR_EVENTS[e].reg] =
     FLPR_EVENTS[e].val;
    SID = &cRSID_C64.SID[chip];
    if ( SID->BaseAddress ) {
     unsigned short pending = SID->ADSRacc;

     SID->ADSRacc = 0;
     if (pending) cRSID_emulateADSRs(SID, pending, 0);
     SID->ADSRthr = 0;
     cRSID_emulateADSRs(SID, 0, 0);
    }
  }
  FLPR_SPLIT->econs = FLPR_SPLIT->econs + 1;
 }

 /* Rest of the sample, after the last write. */
 if ( cyc > done ) cRSID_splitReplayAdsr((unsigned short)(cyc - done));

 /* Same output-stage selection as the unsplit engine (the tail of
  * cRSID_emulateC64): a tune with the HighQualitySID flag must take the
  * oversampled path. Forcing the light renderer here made HQ tunes play
  * at a different oscillator pitch scale and through a different
  * filter/resampler chain - Leviathan sounded like a different, thinner
  * arrangement from the first note in split mode while cRSID was fine. */
 if ( TIGHTLY (cRSID_C64.HighQualitySID) ) {
  if ( TIGHTLY (cRSID_C64.HighQualityResampler) ) cRSID_emulateHQresampledSIDs();
  else cRSID_emulateOversampledSIDwaves();
 }

 /* Samplerate-paced counters, exactly as the unsplit tail does them
  * (PlayTime drives the >1h clamp, the TOD registers feed PSID tunes
  * that read the CIA clock). */
 if ( CALMLY (!cRSID_C64.RealSIDmode) ) {
  --cRSID_C64.TenthSecondCnt;
  if ( RARELY (cRSID_C64.TenthSecondCnt <= 0) ) {
   cRSID_C64.TenthSecondCnt = cRSID_C64.SampleRate / 10;
   ++( cRSID_C64.IObankRD[((0xDC08) & 0xFFF)] );
   if ( RARELY (cRSID_C64.IObankRD[((0xDC08) & 0xFFF)] >= 10) ) {
    cRSID_C64.IObankRD[((0xDC08) & 0xFFF)] = 0; ++( cRSID_C64.IObankRD[((0xDC09) & 0xFFF)] );
   }
  }
 }
 if ( MOSTLY (cRSID_C64.SecondCnt < cRSID_C64.SampleRate) ) ++cRSID_C64.SecondCnt;
 else { cRSID_C64.SecondCnt = 0; if ( MOSTLY (cRSID.PlayTime<3600) ) ++cRSID.PlayTime; }

 if ( TIGHTLY (cRSID_C64.HighQualitySID) ) {
  Out = TIGHTLY (cRSID_C64.HighQualityResampler) ? *cRSID_emulateHQresampledSIDoutputs()
						 : *cRSID_emulateOversampledSIDoutputs();
 }
 else Out = *cRSID_emulateLightSIDs();
 FLPR_SPLIT->cons = s + 1;
 return Out.L;
}
#endif
