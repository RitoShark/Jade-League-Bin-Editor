using System;
using System.IO;
using System.Windows.Media;

namespace Jade.Services;

public static class ThemeHelper
{
    private static string GetPreferencesFilePath()
    {
        var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var prefsFolder = Path.Combine(appDataPath, "RitoShark", "Jade");
        
        if (!Directory.Exists(prefsFolder))
        {
            Directory.CreateDirectory(prefsFolder);
        }
        
        return Path.Combine(prefsFolder, "preferences.txt");
    }

    public static string ReadPreference(string key, string defaultValue)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            if (!File.Exists(prefsFile)) return defaultValue;

            var lines = File.ReadAllLines(prefsFile);
            foreach (var line in lines)
            {
                var trimmedLine = line.Trim();
                if (trimmedLine.StartsWith($"{key}="))
                {
                    return trimmedLine.Substring(key.Length + 1).Trim();
                }
            }
        }
        catch { }
        return defaultValue;
    }

    public static void WritePreference(string key, string value)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            var lines = new System.Collections.Generic.List<string>();
            bool found = false;
            
            if (File.Exists(prefsFile))
            {
                foreach (var line in File.ReadAllLines(prefsFile))
                {
                    var trimmedLine = line.Trim();
                    if (trimmedLine.StartsWith($"{key}="))
                    {
                        lines.Add($"{key}={value}");
                        found = true;
                    }
                    else if (!string.IsNullOrWhiteSpace(trimmedLine))
                    {
                        lines.Add(line);
                    }
                }
            }
            
            if (!found)
            {
                lines.Add($"{key}={value}");
            }
            
            File.WriteAllLines(prefsFile, lines);
        }
        catch (Exception ex)
        {
            Logger.Error($"Failed to write preference {key}", ex);
        }
    }

    public static SolidColorBrush GetBrushFromHex(string hex)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(hex)) return Brushes.Transparent;
            if (!hex.StartsWith("#")) hex = "#" + hex;
            return (SolidColorBrush)new BrushConverter().ConvertFrom(hex)!;
        }
        catch
        {
            return Brushes.Transparent;
        }
    }

    public static SolidColorBrush GetBrighterBrush(SolidColorBrush brush, double factor)
    {
        try
        {
            var color = brush.Color;
            return new SolidColorBrush(Color.FromRgb(
                (byte)Math.Min(255, color.R * factor),
                (byte)Math.Min(255, color.G * factor),
                (byte)Math.Min(255, color.B * factor)));
        }
        catch { return brush; }
    }
    
    public static Color GetBrighterColor(Color color, double factor)
    {
        try
        {
            return Color.FromRgb(
                (byte)Math.Min(255, color.R * factor),
                (byte)Math.Min(255, color.G * factor),
                (byte)Math.Min(255, color.B * factor));
        }
        catch { return color; }
    }

    public static (string keyword, string comment, string stringColor, string number, string propertyColor) GetThemeSyntaxColors(string themeId)
    {
        Logger.Info($"Getting syntax colors for theme: {themeId}");
        var (k, c, s, n, p) = GetHexColorsForTheme(themeId);
        return (k.Trim(), c.Trim(), s.Trim(), n.Trim(), p.Trim());
    }
    
    public static (string keyword, string comment, string stringColor, string number, string propertyColor) GetHexColorsForTheme(string themeId)
    {
        // Delegate to ThemesWindow as the single source of truth for syntax colors
        // This eliminates duplication and makes it easier to update colors in one place
        return Jade.Windows.ThemesWindow.GetFullSyntaxColors(themeId);
    }

    public static Color[] GetBracketColors(string themeId)
    {
        // Hardcoded bracket colors for each theme, matching the preview swatches in ThemesWindow
        return themeId switch
        {
            "DarkBlue" => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(218, 112, 214), Color.FromRgb(0, 191, 255) },
            "DarkRed" => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(255, 105, 180), Color.FromRgb(255, 140, 0) },
            "LightPink" => new[] { Color.FromRgb(75, 0, 130), Color.FromRgb(138, 43, 226), Color.FromRgb(148, 0, 211) },
            "PastelBlue" => new[] { Color.FromRgb(184, 134, 11), Color.FromRgb(139, 0, 139), Color.FromRgb(0, 100, 0) },
            "ForestGreen" => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(64, 224, 208), Color.FromRgb(173, 255, 47) },
            "AMOLED" => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(0, 255, 255), Color.FromRgb(255, 0, 255) },
            "Void" => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(186, 85, 211), Color.FromRgb(138, 43, 226) },
            "VioletSorrow" => new[] { Color.FromRgb(147, 112, 219), Color.FromRgb(138, 43, 226), Color.FromRgb(186, 85, 211) },
            "HighContrast" => new[] { Color.FromRgb(255, 255, 0), Color.FromRgb(0, 255, 0), Color.FromRgb(255, 0, 0) },
            "OrangeBurnout" => new[] { Color.FromRgb(255, 140, 0), Color.FromRgb(218, 165, 32), Color.FromRgb(255, 69, 0) },
            "PurpleGrief" => new[] { Color.FromRgb(190, 159, 225), Color.FromRgb(225, 190, 231), Color.FromRgb(149, 117, 205) },
            "VSCode" => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(218, 112, 214), Color.FromRgb(23, 159, 255) },
            "StandardFlint" => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(218, 112, 214), Color.FromRgb(23, 159, 255) },
            _ => new[] { Color.FromRgb(255, 215, 0), Color.FromRgb(218, 112, 214), Color.FromRgb(135, 206, 250) } // Default/Classic
        };
    }
}

