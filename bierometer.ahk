#Persistent

Loop
{
    FileRead, trigger, C:\bierometer\show.txt

    if (trigger = "show")
    {
        WinActivate, Bierometer
        Sleep, 20000
        WinActivate, PowerPoint
        FileDelete, C:\bierometer\show.txt
    }

    Sleep, 1000
}