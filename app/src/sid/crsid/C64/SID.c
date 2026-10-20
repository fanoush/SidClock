
//cRSID SID emulation engine

#include "SID_ADSR.c"
#include "SID_OscWaves.c"
#include "SID_Outputs.c"


unsigned short cRSID_getSIDbase (int sid_number) {
 return cRSID_C64.SID[ sid_number ].BaseAddress;
}

unsigned short cRSID_getSIDmodel (int sid_number) {
 return cRSID_C64.SID[ sid_number ].ChipModel;
}
unsigned short cRSID_setSIDmodel (int sid_number, unsigned short value) {
 return ( cRSID_C64.SID[ sid_number ].ChipModel = value );
}

unsigned char cRSID_getSIDchannel (int sid_number) { //channel in stereo field (left/right/middle)
 return cRSID_C64.SID[ sid_number ].Channel;
}

int cRSID_getSIDlevel (int sid_number) {
 return cRSID_C64.SID[ sid_number ].Level;
}


void cRSID_createSIDchip (cRSID_SIDinstance* SID, unsigned short model, char channel, unsigned short baseaddress) {
 //static cRSID_C64instance* C64 = &cRSID_C64;

 //SID->C64 = C64;
 SID->ADSRacc = 0; SID->ADSRthr = 0; SID->ADSRquiet = 0; //OPT: fresh emulation state; thr=0 forces a pass at the first instruction (see SID_ADSR.c)
 SID->ChipModel = model; SID->Channel=channel;
 if( baseaddress>=0xD400 && (baseaddress<0xD800 || (0xDE00<=baseaddress && baseaddress<=0xDFE0)) ) { //check valid address, avoid Color-RAM
  SID->BaseAddress = baseaddress; SID->BasePtr = &cRSID_C64.IObankWR[((baseaddress) & 0xFFF)]; SID->BasePtrRD = &cRSID_C64.IObankRD[((baseaddress) & 0xFFF)];
#ifdef CRSID_SPLIT_SID_SIDE
  //Split B: the M33 renders the SID stage from its own register copy.
  if ( cRSID_splitMode ) SID->BasePtr = (unsigned char*)FLPR_SID_REGCOPY;
#endif
 }
 else { SID->BaseAddress=0x0000;
 SID->BasePtr = SID->BasePtrRD = &cRSID_C64.SIDnullGuard; } //slim: sink never read (BaseAddress==0); NULL-ing not preferred as it can cause Segfault in sample-thread
 cRSID_initSIDchip(SID);           //(and guarding against NULL BasePtr would take some precious cycles in SID-emulation functions)
}


void cRSID_initSIDchip (cRSID_SIDinstance* SID) {
 static unsigned char Channel;
 SID->ADSRacc = 0; SID->ADSRthr = 0; SID->ADSRquiet = 0; //OPT: fresh emulation state; thr=0 forces a pass at the first instruction (see SID_ADSR.c)
 for (Channel = 0; Channel < 21; Channel+=7) {
  SID->ADSRstate[Channel] = 0; SID->RateCounter[Channel] = 0;
  SID->EnvelopeCounter[Channel] = 0; SID->ExponentCounter[Channel] = 0;
  SID->PhaseAccu[Channel] = 0; SID->PrevPhaseAccu[Channel] = 0;
  SID->NoiseLFSR[Channel] = 0x7FFFFF;
  SID->PrevWavGenOut[Channel] = 0; SID->PrevWavData[Channel] = 0;
  SID->PrevSounDemonDigiWF[Channel] = 0x00;
 }
#ifdef CRSID_SPLIT_SID_SIDE
 /* Split engine: the chip's SID registers live in the shared copy that
  * BasePtr points at, which the IO-bank clear below cannot reach. Without
  * this a tune loaded after another one starts with the previous tune's
  * register file (audible as a wrong first pattern - Mikie again). */
 if ( cRSID_splitMode ) {
  volatile unsigned char* regs = (volatile unsigned char*)FLPR_SID_REGCOPY +
                                 (unsigned)(SID - cRSID_C64.SID - 1) * 32U;
  int i;

  for (i = 0; i < 32; i++) regs[i] = 0;
 }
#endif
 SID->SyncSourceMSBrise = 0; SID->RingSourceMSB = 0;
 /* Output stage too: without this a new tune starts from the previous
  * tune's last level / digi offset / filter history. Mikie then played
  * its opening with a DC offset and a different echo pattern, and only an
  * engine switch (which recreated the chips) cleared it. */
 SID->PrevLowPass = SID->PrevBandPass = SID->PrevVolume = 0;
 SID->NonFiltedSample = 0; SID->FilterInputSample = 0;
 SID->PrevNonFiltedSample = 0; SID->PrevFilterInputSample = 0;
 SID->Digi = 0; SID->Output = 0; SID->Level = 0;
 SID->Volume = 0; SID->Resonance = 0; SID->Cutoff = 0;
 SID->HighPassBit = 0; SID->BandPassBit = 0; SID->LowPassBit = 0;
}


static INLINE int cRSID_emulateHQresampledSID (FASTVAR cRSID_SIDinstance *const FASTPTR SID, FASTVAR char cycles) {
 //cause immediate stopping in audio-buffer thread, so SID-baseaddress changes during tune-switching won't give segfaults
 //if ( RARELY (cRSID.Paused || SID->BasePtr == NULL) ) return 0; //avoid some segfaults when NULL-ing SID4
 SID->Output = cRSID_emulateHQresampledSIDoutputStage( SID, cRSID_emulateHQwaves( SID, cycles ) );  // * SID->Volume;
 return SID->Output;
}

