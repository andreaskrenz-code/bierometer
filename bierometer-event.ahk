#Persistent
SetTitleMatchMode, 2

overlayTitle := "Königsträsser Bierometer"

Loop
{

if FileExist("C:\bierometer\show.txt")
{

FileDelete, C:\bierometer\show.txt

; Bierometer Fenster aktivieren
WinActivate, %overlayTitle%

Sleep, 200

; Immer im Vordergrund
WinSet, AlwaysOnTop, On, %overlayTitle%

; Monitor 2 Position
SysGet, Monitor2, Monitor, 2

WinMove, %overlayTitle%,
, Monitor2Left
, Monitor2Top
, Monitor2Right - Monitor2Left
, Monitor2Bottom - Monitor2Top

; 20 Sekunden anzeigen
Sleep, 20000

; Overlay ausblenden
WinSet, AlwaysOnTop, Off, %overlayTitle%
WinMinimize, %overlayTitle%

}

Sleep, 200

}