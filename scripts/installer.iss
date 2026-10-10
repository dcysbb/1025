#define AppName "Vacuum Interlock"
#define AppVersion "0.1.1"
[Setup]
AppId={{447C89B3-FD6F-48A1-88AA-5A4B4B973C4D}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\VacuumInterlock
DefaultGroupName={#AppName}
OutputDir=..\backend\dist\installer
OutputBaseFilename=VacuumInterlock-Setup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
UninstallDisplayIcon={app}\VacuumInterlock.exe
[Files]
Source: "..\backend\dist\VacuumInterlock\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\backend\dist\VacuumInterlockService\*"; DestDir: "{app}\service"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "open-control-panel.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
[Tasks]
Name: "service"; Description: "Install the background Windows service (starts after manual configuration)"; Flags: unchecked
[Icons]
Name: "{group}\Open Control Panel"; Filename: "powershell.exe"; Parameters: "-NoProfile -File ""{app}\scripts\open-control-panel.ps1"""
Name: "{group}\Documentation"; Filename: "{app}\README.md"
[Run]
Filename: "{app}\service\VacuumInterlockService.exe"; Parameters: "--startup auto install"; Tasks: service; Flags: runhidden waituntilterminated
[UninstallRun]
Filename: "{app}\service\VacuumInterlockService.exe"; Parameters: "stop"; Tasks: service; Flags: runhidden waituntilterminated; RunOnceId: "StopVacuumService"
Filename: "{app}\service\VacuumInterlockService.exe"; Parameters: "remove"; Tasks: service; Flags: runhidden waituntilterminated; RunOnceId: "RemoveVacuumService"
