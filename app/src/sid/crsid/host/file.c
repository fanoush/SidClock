
#include "stdint.h"
#include "stdio.h"
#include "string.h"
#include "ctype.h"
#ifdef CRSID_PLATFORM_PC
 #include "libgen.h"
#endif

#include "md5.c"



static const char* findSongLengthRow (const char* text, const char* prefix) { //, char** delimiter) {
   static const char* line_end;
   const char* line_start = text;
   size_t prefix_len = strlen(prefix);
   while (*line_start != '\0') { // Find next newline
       line_end = strchr(line_start, '\n');
       if (line_end == NULL) {
           line_end = line_start + strlen(line_start);
       }
       const char* actual_end = line_end;
       if (line_end > line_start && *(line_end - 1) == '\r') { // Adjust for \r\n if present
           actual_end--;
       }
       if (strncmp(line_start, prefix, prefix_len) == 0) { //printf("Found line: %.*s\n", (int)(actual_end - line_start), line_start);
           //*delimiter = (char*) actual_end;
           return line_start;
       }
       line_start = (*line_end == '\0') ? line_end : line_end + 1;
   }
   return NULL;
}


void cRSID_getPlaylengths (unsigned char* filedata, int filesize) {
 //Embedded slim-down: SongLengths DB is never loaded on device (own .len
 //sidecars instead), so skip the MD5/database lookup entirely (also drops
 //the MD5 statics/code). Durations stay zeroed as before.
 static int i;
 for (i=0; i<33; ++i) cRSID.SubtuneDurations[i] = 0;
 (void)filedata; (void)filesize;
}



#ifdef CRSID_PLATFORM_PC



char* cRSID_fileNameOnly (char* path) {
 int LastPos; char* name;
 LastPos=strlen(path)-1;
 #ifndef WINDOWS
  if (path[LastPos] == '/') path[LastPos]='\0'; //remove possible trailing slash if foldername
  return basename(path);
 #else
  if (path[LastPos] == '\\') path[LastPos]='\0'; //remove possible trailing slash if foldername
  name=strrchr(path,'\\'); if(name==NULL) name=strrchr(path,'/');  return (name!=NULL)? name+1:path;
 #endif
}

char* cRSID_folderNameOnly (char* path) {
  return dirname(path);
}


char cRSID_compareFileExtension (char *filename, char *extension) {
 short i,j;  //get pointer of file-extension from filename string  //if no '.' found, point to end of the string
 for (i=strlen(filename)-1,j=strlen(extension)-1; i>=0 && j>=0; --i,--j) {
  if(tolower(filename[i])!=tolower(extension[j])) return 0;
 }
 return 1;
}

char cRSID_playableExtension (char *name) {
 if (name==NULL) return 0;
 cRSID_removeNewline(name);
 return cRSID_compareFileExtension(name,CRSID_SID_FILE_EXTENSION) || cRSID_compareFileExtension(name,CRSID_SID_FILE_EXTENSION_ALTERNATIVE); //|| cRSID_compareFileExtension(name,".sid.prg") || cRSID_compareFileExtension(name,".prg");
}


int cRSID_loadSIDfile (unsigned char* SIDfileData, char* filename, int maxlen) {
 static signed short Data;
 static signed int SizeCnt;
 static FILE *SIDfile;
 /*#ifndef CRSID_LIBRARY
  //static
         #include "../../resources/builtin-music.h"
 #endif*/

 SizeCnt=0;
 if (cRSID.BuiltInMusic==0) {
  if ( (SIDfile=fopen(filename,"rb")) == NULL || !cRSID_playableExtension(filename) ) return CRSID_ERROR_LOAD;
  while ( (Data=fgetc(SIDfile)) != EOF ) {
   if (SizeCnt >= maxlen) return CRSID_ERROR_LOAD;
   SIDfileData[SizeCnt] = Data; SizeCnt++;
  }
  fclose(SIDfile);
 }
 //#ifndef CRSID_LIBRARY
 else {
  while (cRSID.BuiltInMusicData != NULL && SizeCnt < cRSID.BuiltInMusicSize)
  { SIDfileData[SizeCnt] = cRSID.BuiltInMusicData[SizeCnt]; ++SizeCnt; } //cRSID.BuiltInMusic=0; }  //else while(SizeCnt<(int)sizeof(builtin_music)) { SIDfileData[SizeCnt] = builtin_music[SizeCnt]; ++SizeCnt; }
 }
 //#endif

 cRSID_getPlaylengths( SIDfileData, SizeCnt ); //getting the info early, but later on too in processSIDfileData()

 return SizeCnt;
}


#endif //CRSID_PLATFORM_PC


cRSID_SIDheader* cRSID_processSIDfileData (unsigned char* filedata, int filesize) {
 static int i;
 static unsigned short SIDdataOffset;
 static cRSID_SIDheader *SIDheader;
 static const char MagicStringPSID[]="PSID";
 //static const char MagicStringRSID[]="RSID";

 cRSID.SIDheader = SIDheader = (cRSID_SIDheader*) filedata;

 //copy KERNAL & BASIC ROM contents into the RAM under them? (So PSIDs that don't select bank correctly will work better.)
 //Embedded slim-down: ROMbanks removed; refresh the RAM-copy stubs per load (as the old ROMbanks->RAMbank copy did).
 cRSID_setROMcontent();
 for (i=0x0000; i < 0xA000; ++i) cRSID_C64.RAMbank[i]=0; //fresh start (maybe some bugged SIDs want 0 at certain RAM-locations)
 for (i=0xC000; i < 0xD000; ++i) cRSID_C64.RAMbank[i]=0;

 if ( SIDheader->MagicString[0] != 'P' && SIDheader->MagicString[0] != 'R' ) return NULL;
 for (i=1; i < (int)(sizeof(MagicStringPSID)-1); ++i) { if (SIDheader->MagicString[i] != MagicStringPSID[i]) return NULL; }
 cRSID.RealSIDmode = ( SIDheader->MagicString[0] == 'R' );
 cRSID_C64.RealSIDmode = cRSID.RealSIDmode; //update shadowed copy used by the audio thread (sound-thread shouldn't run at this moment)

 if (SIDheader->LoadAddressH==0 && SIDheader->LoadAddressL==0) { //load-address taken from first 2 bytes of the C64 PRG
  cRSID.LoadAddress = (filedata[SIDheader->HeaderSize+1]<<8) + (filedata[SIDheader->HeaderSize+0]);
  SIDdataOffset = SIDheader->HeaderSize+2;
 }
 else { //load-adress taken from SID-header
  cRSID.LoadAddress = (SIDheader->LoadAddressH<<8) + (SIDheader->LoadAddressL);
  SIDdataOffset = SIDheader->HeaderSize;
 }

 //Used by subtune-playback too after first init, so tunes that modify memory can start with a freshly loaded data:
 //Embedded slim-down: optional streaming source (libcsid_stream_fill, same
 //pattern as cSID-light) for files too large to buffer; reads filedata[i]
 //for i in [SIDdataOffset, filesize), zero extra RAM (writes go straight to
 //RAMbank). LoadAddress+len is clamped to 64KB (the old engine checked too).
 if (libcsid_stream_fill != NULL) {
  int pos = 0, remaining = filesize - SIDdataOffset, got, want, addr, room;
  //Non-PRG tunes (explicit header load address): payload starts at
  //HeaderSize but the app stream starts at HeaderSize+2 (like cSID-light's
  //offs+2); the 2 lead bytes come from the already-buffered header.
  //Standard 124-byte headers always fit the device's 128-byte header buffer.
  while (pos < 2 && SIDdataOffset + pos < (int)SIDheader->HeaderSize + 2 && remaining > 0) {
   addr = cRSID.LoadAddress + pos;
   if (addr < 0x10000) cRSID_C64.RAMbank[addr] = filedata[SIDdataOffset + pos];
   ++pos; --remaining;
  }
  while (remaining > 0) {
   want = remaining < 512 ? remaining : 512;
   addr = cRSID.LoadAddress + pos;
   room = 0x10000 - addr;
   if (room <= 0) break;
   if (want > room) want = room;
   got = libcsid_stream_fill(&cRSID_C64.RAMbank[addr], want);
   if (got <= 0) break;
   if (got > want) got = want;
   pos += got; remaining -= got;
  }
 }
 else for (i=SIDdataOffset; i<filesize; ++i) {
  int addr = cRSID.LoadAddress + (i-SIDdataOffset);
  if (addr < 0x10000) cRSID_C64.RAMbank[addr] = filedata[i];
 }

 i = cRSID.LoadAddress + (filesize-SIDdataOffset);
 cRSID.EndAddress = (i<0x10000) ? i : 0xFFFF;

 cRSID.PSIDdigiMode = ( !cRSID.RealSIDmode && (SIDheader->ModelFormatStandard & 2) );

 cRSID_getPlaylengths( filedata, filesize );
 if (cRSID.FallbackPlayTime > 0) {
    for (i=0; i<33; ++i) { if (cRSID.SubtuneDurations[i] <= 0) cRSID.SubtuneDurations[i] = cRSID.FallbackPlayTime; }
 }

 #ifdef CRSID_PLATFORM_PC
 if (cRSID.PlayTimeMinutes[cRSID.PlayListPlayPosition] || cRSID.PlayTimeSeconds[cRSID.PlayListPlayPosition]) {//if playtime is given in playlist, override for 1st subtune
  cRSID.SubtuneDurations[ 1 ] = cRSID.PlayTimeMinutes[cRSID.PlayListPlayPosition] * CRSID_SECONDS_PER_MINUTE + cRSID.PlayTimeSeconds[cRSID.PlayListPlayPosition];
 }
 #endif

 return cRSID.SIDheader;
}

