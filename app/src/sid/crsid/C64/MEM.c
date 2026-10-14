
//Emulation of C64 memories and memory bus (PLA & MUXes)

#include "C64.h"


extern cRSID_C64instance cRSID_C64;


void cRSID_generateMemoryBankPointers () {
 //Embedded slim-down: bank-pointer tables removed (8KB); the same PLA
 //selection logic now lives in cRSID_getMemReadPtr/cRSID_getMemWritePtr below.
 //Kept as a no-op for the cRSID_initC64() call-site.
}


static INLINE unsigned char* cRSID_getMemReadPtr (FASTVAR unsigned short address) {
 //cRSID_C64instance* const C64 = &cRSID_C64; //for faster (?) operation we use a global object as memory
 //Banking identical to the old MemoryBankPointersRD table: D-page with IO
 //enabled goes to the (4KB, & 0xFFF-indexed) IO banks, everything else to
 //RAMbank. (Old ROMbanks selection now reads the RAM copy holding the ROM
 //stubs, like the single-memory model of cSID-light.)
 if ( MOSTLY (cRSID_C64.RAMbank[1] & 3) && MOSTLY (0xD000 <= address) && MOSTLY (address < 0xE000) ) {
  if ( MOSTLY (address < 0xD400 || 0xD419 <= address) ) return &( cRSID_C64.IObankRD[address & 0xFFF] );
  else return &cRSID_C64.IObankWR[address & 0xFFF]; //emulate bitfading aka SID-read of last written reg (e.g. Lift Off ROR $D400,x)
 }
 return &cRSID_C64.RAMbank[address];
}
 /*if (address<0xA000) return &cRSID_C64.RAMbank[address];
 else if ( 0xD000<=address && address<0xE000 && (cRSID_C64.RAMbank[1]&3) ) {
  if (0xD400 <= address && address < 0xD419) return &cRSID_C64.IObankWR[((address) & 0xFFF)]; //emulate bitfading aka SID-read of last written reg (e.g. Lift Off ROR $D400,x)
  return &cRSID_C64.IObankRD[((address) & 0xFFF)];
 }
 else if ( (address<0xC000 && (cRSID_C64.RAMbank[1]&3)==3)
           || (0xE000<=address && (cRSID_C64.RAMbank[1]&2)) ) return &cRSID_C64.RAMbank[(address)];
 return &cRSID_C64.RAMbank[address];*/

//static INLINE unsigned char* cRSID_getMemReadPtrC64 (cRSID_C64instance* C64, FASTVAR unsigned short address) {
// return & ( MemoryBankPointersRD[ cRSID_C64.RAMbank[1] & 3 ][ address >> 8 ] ) [ address ];
 /*if (address<0xA000) return &C64->RAMbank[address];
 else if ( 0xD000<=address && address<0xE000 && (C64->RAMbank[1]&3) ) {
  if (0xD400 <= address && address < 0xD419) return &C64->IObankWR[((address) & 0xFFF)]; //emulate peculiar SID-read (e.g. Lift Off)
  return &C64->IObankRD[((address) & 0xFFF)];
 }
 else if ( (address<0xC000 && (C64->RAMbank[1]&3)==3)
           || (0xE000<=address && (C64->RAMbank[1]&2)) ) return &C64->RAMbank[(address)];
 return &C64->RAMbank[address];*/
//}


static INLINE unsigned char* cRSID_getMemWritePtr (FASTVAR unsigned short address) {
 //cRSID_C64instance* const C64 = &cRSID_C64; //for faster (?) operation we use a global object as memory
 //Banking identical to the old MemoryBankPointersWR table: D-page with IO
 //enabled goes to the (4KB, & 0xFFF-indexed) WR bank (with SID-mirror
 //remapping), everything else (incl. former ROM areas) to RAMbank.
 if ( MOSTLY (address < 0xD000 || 0xE000 <= address) || MOSTLY (!(cRSID_C64.RAMbank[1] & 3)) )
  return &cRSID_C64.RAMbank[address];
 if ( RARELY (0xD420 <= address && address < 0xD800) ) { //CIA/VIC mirrors needed?
  if ( LIKELY ( !(cRSID.PSIDdigiMode && 0xD418 <= address && address < 0xD500)
        && !(cRSID_C64.SID[2].BaseAddress <= address && address < cRSID_C64.SID[2].BaseAddress+0x20)
        && !(cRSID_C64.SID[3].BaseAddress <= address && address < cRSID_C64.SID[3].BaseAddress+0x20)
        && !(cRSID_C64.SID[4].BaseAddress <= address && address < cRSID_C64.SID[4].BaseAddress+0x20) ) ) {
   return &cRSID_C64.IObankWR[(( (0xD400 + (address&0x1F)) & 0xFFF ) & 0xFFF)]; //write to $D400..D41F if not in SID2/SID3 address-space
  }
 }
 return &( cRSID_C64.IObankWR[(( address & 0xFFF ) & 0xFFF)] );
 /*if (address<0xD000 || 0xE000<=address) return &cRSID_C64.RAMbank[address];
 else if ( cRSID_C64.RAMbank[1]&3 ) { //handle SID-mirrors! (CJ in the USA workaround (writing above $d420, except SID2/SID3))
  if (0xD420 <= address && address < 0xD800) { //CIA/VIC mirrors needed?
   if ( !(cRSID_C64.PSIDdigiMode && 0xD418 <= address && address < 0xD500)
        && !(cRSID_C64.SID[2].BaseAddress <= address && address < cRSID_C64.SID[2].BaseAddress+0x20)
        && !(cRSID_C64.SID[3].BaseAddress <= address && address < cRSID_C64.SID[3].BaseAddress+0x20)
        && !(cRSID_C64.SID[4].BaseAddress <= address && address < cRSID_C64.SID[4].BaseAddress+0x20) ) {
    return &cRSID_C64.IObankWR[(( 0xD400 + (address&0x1F) ) & 0xFFF)]; //write to $D400..D41F if not in SID2/SID3 address-space
   }
   else return &cRSID_C64.IObankWR[((address) & 0xFFF)];
  }
  else return &cRSID_C64.IObankWR[((address) & 0xFFF)];
 }
 return &cRSID_C64.RAMbank[address];*/
}


//static INLINE unsigned char* cRSID_getMemWritePtrC64 (cRSID_C64instance* C64, FASTVAR unsigned short address) {
// return & ( MemoryBankPointersWR[ cRSID_C64.RAMbank[1] & 3 ][ address >> 8 ] ) [ address ];
 /*if (address<0xD000 || 0xE000<=address) return &C64->RAMbank[address];
 else if ( C64->RAMbank[1]&3 ) { //handle SID-mirrors! (CJ in the USA workaround (writing above $d420, except SID2/SID3/PSIDdigi))
  if (0xD420 <= address && address < 0xD800) { //CIA/VIC mirrors needed?
   if ( !(cRSID_C64.PSIDdigiMode && 0xD418 <= address && address < 0xD500)
        && !(C64->SID[2].BaseAddress <= address && address < C64->SID[2].BaseAddress+0x20)
        && !(C64->SID[3].BaseAddress <= address && address < C64->SID[3].BaseAddress+0x20)
        && !(C64->SID[4].BaseAddress <= address && address < C64->SID[4].BaseAddress+0x20) ) {
    return &C64->IObankWR[(( 0xD400 + (address&0x1F) ) & 0xFFF)]; //write to $D400..D41F if not in SID2/SID3 address-space
   }
   else return &C64->IObankWR[((address) & 0xFFF)];
  }
  else return &C64->IObankWR[((address) & 0xFFF)];
 }
 return &C64->RAMbank[address];*/
//}


static INLINE unsigned char cRSID_readMem (FASTVAR unsigned short address) {
 return *cRSID_getMemReadPtr(address);
}

/*static INLINE unsigned char cRSID_readMemC64 (cRSID_C64instance* C64, FASTVAR unsigned short address) {
 return *cRSID_getMemReadPtrC64(C64,address);
}*/


static INLINE void cRSID_writeMem (FASTVAR unsigned short address, FASTVAR unsigned char data) {
 *cRSID_getMemWritePtr(address)=data;
}

/*static INLINE void cRSID_writeMemC64 (cRSID_C64instance* C64, FASTVAR unsigned short address, FASTVAR unsigned char data) {
 *cRSID_getMemWritePtrC64(C64,address)=data;
}*/


void cRSID_setROMcontent () { //fill KERNAL/BASIC-ROM areas with content needed for SID-playback
 //Embedded slim-down: ROMbanks removed; the stubs (and optional KERNAL/BASIC
 //file content) live in the RAM copy, like the single-memory model of cSID-light.
 //static cRSID_C64instance* C64 = &cRSID_C64;
 int i;
 static const unsigned char ROM_IRQreturnCode[9] = {0xAD,0x0D,0xDC,0x68,0xA8,0x68,0xAA,0x68,0x40}; //CIA1-acknowledge IRQ-return
 static const unsigned char ROM_NMIstartCode[5] = {0x78,0x6c,0x18,0x03,0x40}; //SEI and jmp($0318)
 static const unsigned char ROM_IRQBRKstartCode[19] = { //Full IRQ-return (handling BRK with the same RAM vector as IRQ)
  0x48,0x8A,0x48,0x98,0x48,0xBA,0xBD,0x04,0x01,0x29,0x10,0xEA,0xEA,0xEA,0xEA,0xEA,0x6C,0x14,0x03
 };

 //RAM-under-IO ($D000..$DFFF) keeps its own state and is intentionally skipped.
 for (i=0xA000; i<0xD000; ++i) cRSID_C64.RAMbank[i] = 0x60; //RTS (at least return if some unsupported call is made to ROM)
 for (i=0xE000; i<0x10000; ++i) cRSID_C64.RAMbank[i] = 0x60;

 if (cRSID.BASICfileData != NULL) { for (i = 0; i < 0x2000; ++i) cRSID_C64.RAMbank[0xA000+i] = cRSID.BASICfileData[i]; }

 if (cRSID.KERNALfileData != NULL) { for (i = 0; i < 0x2000; ++i) cRSID_C64.RAMbank[0xE000+i] = cRSID.KERNALfileData[i]; }   //for (i=0; i<sizeof(KERNAL); ++i) cRSID_C64.RAMbank[0xE000+i] = KERNAL[i];
 else {
  for (i=0xEA31; i<0xEA7E; ++i) cRSID_C64.RAMbank[i] = 0xEA; //NOP (full IRQ-return leading to simple IRQ-return without other tasks)
  for (i=0; i<9; ++i) cRSID_C64.RAMbank [0xEA7E + i] = ROM_IRQreturnCode[i];
  for (i=0; i<4; ++i) cRSID_C64.RAMbank [0xFE43 + i] = ROM_NMIstartCode[i];
  for (i=0; i<19; ++i) cRSID_C64.RAMbank[0xFF48 + i] = ROM_IRQBRKstartCode[i];
  cRSID_C64.RAMbank[0xFFFB] = 0xFE; cRSID_C64.RAMbank[0xFFFA] = 0x43; //ROM NMI-vector
  cRSID_C64.RAMbank[0xFFFF] = 0xFF; cRSID_C64.RAMbank[0xFFFE] = 0x48; //ROM IRQ-vector
 }
}


void cRSID_initMem () { //set default values that normally KERNEL ensures after startup/reset (only SID-playback related)
 //static cRSID_C64instance* C64 = &cRSID_C64;
 static int i;

 //data required by both PSID and RSID (according to HVSC SID_file_format.txt):
 cRSID_writeMem( 0x02A6, cRSID.VideoStandard  ); //cRSID_writeMemC64( C64, 0x02A6, cRSID_C64.VideoStandard  ); //$02A6 should be pre-set to: 0:NTSC / 1:PAL
 cRSID_writeMem( 0x0001, 0x37 ); //cRSID_writeMemC64( C64, 0x0001, 0x37 ); //initialize bank-reg. (ROM-banks and IO enabled)

 //if (cRSID_C64.RAMbank[(0xE000)]==0) { //wasn't a KERNAL-ROM loaded? (e.g. PSID)
  cRSID_writeMem( 0x00CB, 0x40 ); //cRSID_writeMemC64( C64, 0x00CB, 0x40 ); //Some tunes might check for keypress here (e.g. Master Blaster Intro)
  //if(cRSID.RealSIDmode) {
   cRSID_writeMem( 0x0315, 0xEA ); cRSID_writeMem( 0x0314, 0x31 ); //cRSID_writeMemC64( C64, 0x0315, 0xEA ); cRSID_writeMemC64( C64, 0x0314, 0x31 ); //IRQ
   cRSID_writeMem( 0x0319, 0xEA/*0xFE*/ ); cRSID_writeMem( 0x0318, 0x81/*0x47*/ ); //cRSID_writeMemC64( C64, 0x0319, 0xEA/*0xFE*/ ); cRSID_writeMemC64( C64, 0x0318, 0x81/*0x47*/ ); //NMI
  //}

  for (i=0xD000; i<0xD7FF; ++i) cRSID_C64.IObankRD[((i) & 0xFFF)] = cRSID_C64.IObankWR[((i) & 0xFFF)] = 0; //initialize the whole IO area for a known base-state
  if(cRSID.RealSIDmode) {cRSID_C64.IObankWR[((0xD012) & 0xFFF)] = 0x37; cRSID_C64.IObankWR[((0xD011) & 0xFFF)] = 0x8B;} //else cRSID_C64.IObankWR[((0xD012) & 0xFFF)] = 0;
  //cRSID_C64.IObankWR[((0xD019) & 0xFFF)] = 0; //PSID: rasterrow: any value <= $FF, IRQ:enable later if there is VIC-timingsource

  cRSID_C64.IObankRD[((0xDC00) & 0xFFF)]=0x10; cRSID_C64.IObankRD[((0xDC01) & 0xFFF)]=0xFF; //Imitate CIA1 keyboard/joy port, some tunes check if buttons are not pressed
  if (cRSID.VideoStandard) { cRSID_C64.IObankWR[((0xDC04) & 0xFFF)]=0x24; cRSID_C64.IObankWR[((0xDC05) & 0xFFF)]=0x40; } //initialize CIAs
  else { cRSID_C64.IObankWR[((0xDC04) & 0xFFF)]=0x95; cRSID_C64.IObankWR[((0xDC05) & 0xFFF)]=0x42; }
  if (cRSID.RealSIDmode) cRSID_C64.IObankWR[((0xDC0D) & 0xFFF)] = 0x81; //Reset-default, but for PSID CIA1 TimerA IRQ should be enabled anyway if SID is CIA-timed
  cRSID_C64.IObankWR[((0xDC0E) & 0xFFF)] = 0x01; //some tunes (and PSID doc) expect already running CIA (Reset-default)
  cRSID_C64.IObankWR[((0xDC0F) & 0xFFF)] = 0x00; //All counters other than CIA1 TimerA should be disabled and set to 0xFF for PSID:
  cRSID_C64.IObankWR[((0xDD00) & 0xFFF)] = cRSID_C64.IObankRD[((0xDD00) & 0xFFF)] = 0x03; //VICbank-selector default
  cRSID_C64.IObankWR[((0xDD04) & 0xFFF)] = cRSID_C64.IObankWR[((0xDD05) & 0xFFF)] = 0xFF;
  //cRSID_C64.IObankWR[((0xDD0E) & 0xFFF)] = cRSID_C64.IObank[0xDD0F] = 0x08;
 //}

}

