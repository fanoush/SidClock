#pragma once
#include <stdint.h>
#include "SIDConfig.h"

#ifdef __cplusplus
extern "C" {
#endif

//#define MAX_DATA_LEN 65536

#define SIDMODEL_8580 8580
#define SIDMODEL_6581 6581

#define DEFAULT_SAMPLERATE 44100
#define DEFAULT_SIDMODEL SIDMODEL_6581

extern void libcsid_init(int samplerate, int sidmodel);
extern void libcsid_free();

//extern int libcsid_load(unsigned char *buffer, int bufferlen, int subtune);
extern int libcsid_load(unsigned char *buffer, int bufferlen);
extern void libcsid_play(int tune_index);

extern const char *libcsid_getauthor();
extern const char *libcsid_getinfo();
extern const char *libcsid_gettitle();
extern uint8_t libcsid_get_total_tunes_number();
extern uint8_t libcsid_get_default_tune_number();

extern void libcsid_render(unsigned short *output, int numsamples);

#ifdef SID_ENGINE_DUAL
/* Dual-engine build only: select the core for subsequent init/load/play
 * calls (0 = cRSID Light, 1 = legacy cSID-light). Both share one 64 KB
 * C64 RAM; selecting re-initialises on the next load. */
extern void libcsid_select_engine(int legacy);
extern int libcsid_selected_engine(void);
#endif

#ifdef __cplusplus
}
#endif

