// career-ops.exe: runs `node runner.mjs <args>` from the folder the exe sits in,
// with no console window, appending the output to data\runner-log.txt.
// Build with `node runner.mjs build-exe`. Every decision lives in runner.mjs, so
// a fix there never needs this rebuilt.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

static class Launcher
{
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string data = Path.Combine(root, "data");
        Directory.CreateDirectory(data);
        string log = Path.Combine(data, "runner-log.txt");
        // One generation of history. A run still appending (sync during an
        // alert) holds the file open and the move fails; the next run retries.
        try
        {
            if (File.Exists(log) && new FileInfo(log).Length > 5000000)
            {
                File.Delete(log + ".old");
                File.Move(log, log + ".old");
            }
        }
        catch (IOException) { }

        // cmd does the redirect so node's output reaches the log with no
        // console attached. /s strips only the outer quotes.
        string argLine = string.Join(" ", args.Select(Quote));
        var psi = new ProcessStartInfo("cmd.exe",
            "/d /s /c \"node runner.mjs " + argLine + " >> data\\runner-log.txt 2>&1\"")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    static string Quote(string a)
    {
        return a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"', '&', '|', '<', '>', '^' }) < 0
            ? a
            : "\"" + a.Replace("\"", "\\\"") + "\"";
    }
}
