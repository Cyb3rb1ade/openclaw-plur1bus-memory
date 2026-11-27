Option Explicit
' Constant script: the directory path arrives only through PLUR1BUS_ACL_PATH.
' Prints OWNER=<sid> and ACE=<type>,<sid> lines (type 0=Allow, 1=Deny).
Dim sh, path, wmi, file, out, sd, owner, dacl, ace, key
Set sh = CreateObject("WScript.Shell")
path = sh.ExpandEnvironmentStrings("%PLUR1BUS_ACL_PATH%")
If path = "" Or path = "%PLUR1BUS_ACL_PATH%" Then
  WScript.Echo "ERR missing-path"
  WScript.Quit 1
End If
If InStr(path, """") > 0 Or InStr(path, Chr(0)) > 0 Then
  WScript.Echo "ERR bad-path"
  WScript.Quit 1
End If

On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number <> 0 Then
  WScript.Echo "ERR wmi=" & Err.Number
  WScript.Quit 1
End If
Err.Clear
key = Replace(path, "\", "\\")
Set file = wmi.Get("Win32_LogicalFileSecuritySetting.Path=""" & key & """")
If Err.Number <> 0 Then
  WScript.Echo "ERR get=" & Err.Number
  WScript.Quit 1
End If
Err.Clear
Set out = file.ExecMethod_("GetSecurityDescriptor")
If Err.Number <> 0 Then
  WScript.Echo "ERR method=" & Err.Number
  WScript.Quit 1
End If
If out.ReturnValue <> 0 Then
  WScript.Echo "ERR return=" & out.ReturnValue
  WScript.Quit 1
End If
Set sd = out.Descriptor
If Err.Number <> 0 Then
  WScript.Echo "ERR descriptor=" & Err.Number
  WScript.Quit 1
End If
Set owner = sd.Owner
If Err.Number <> 0 Or owner Is Nothing Then
  WScript.Echo "ERR owner"
  WScript.Quit 1
End If
If owner.SIDString = "" Then
  WScript.Echo "ERR owner-sid"
  WScript.Quit 1
End If
WScript.Echo "OWNER=" & owner.SIDString

If IsNull(sd.DACL) Then
  ' Exit 0 so the Node parser sees DACL=NULL and fails closed (no PowerShell fallback).
  WScript.Echo "DACL=NULL"
  WScript.Quit 0
End If
Err.Clear
dacl = sd.DACL
If Err.Number <> 0 Then
  WScript.Echo "ERR dacl=" & Err.Number
  WScript.Quit 1
End If

On Error GoTo 0
If IsEmpty(dacl) Then
  ' empty DACL: owner line only
ElseIf IsArray(dacl) Then
  Dim i
  For i = LBound(dacl) To UBound(dacl)
    If IsObject(dacl(i)) Then
      Set ace = dacl(i)
      EchoAce ace
    Else
      EchoAce dacl(i)
    End If
  Next
Else
  EchoAce dacl
End If

Sub EchoAce(item)
  Dim t, sid
  If item Is Nothing Then
    WScript.Echo "ERR ace-null"
    WScript.Quit 1
  End If
  t = CStr(item.AceType)
  sid = item.Trustee.SIDString
  If sid = "" Then
    WScript.Echo "ERR ace-sid"
    WScript.Quit 1
  End If
  WScript.Echo "ACE=" & t & "," & sid
End Sub
