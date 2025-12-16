using System;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace Jade.Windows;

public partial class AboutWindow : Window
{
    public AboutWindow()
    {
        InitializeComponent();
        
        // Get version from assembly
        var version = Assembly.GetExecutingAssembly().GetName().Version;
        VersionText.Text = version != null ? $"{version.Major}.{version.Minor}.{version.Build}" : "1.0.0";
        
        // Apply current theme
        ApplyWindowTheme(GetCurrentTheme());
    }
    
    private void OnClose(object sender, RoutedEventArgs e)
    {
        Close();
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        DragMove();
    }
    
    private string GetCurrentTheme()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("Theme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("Theme="))
                        {
                            return line.Substring(6).Trim();
                        }
                    }
                }
            }
        }
        catch { }
        
        return "Default";
    }
    
    private void ApplyWindowTheme(string theme)
    {
        SolidColorBrush bgColor, titleBarBg, textColor, mutedText, cardBg, accentColor;
        
        switch (theme)
        {
            case "DarkBlue":
                bgColor = new SolidColorBrush(Color.FromRgb(20, 30, 45));
                titleBarBg = new SolidColorBrush(Color.FromRgb(25, 35, 50));
                textColor = new SolidColorBrush(Color.FromRgb(220, 230, 240));
                mutedText = new SolidColorBrush(Color.FromRgb(120, 140, 160));
                cardBg = new SolidColorBrush(Color.FromRgb(30, 45, 65));
                accentColor = new SolidColorBrush(Color.FromRgb(100, 180, 220));
                break;
            case "DarkRed":
                bgColor = new SolidColorBrush(Color.FromRgb(45, 20, 25));
                titleBarBg = new SolidColorBrush(Color.FromRgb(50, 25, 30));
                textColor = new SolidColorBrush(Color.FromRgb(240, 220, 225));
                mutedText = new SolidColorBrush(Color.FromRgb(160, 120, 130));
                cardBg = new SolidColorBrush(Color.FromRgb(60, 30, 35));
                accentColor = new SolidColorBrush(Color.FromRgb(220, 100, 120));
                break;
            case "LightPink":
                bgColor = new SolidColorBrush(Color.FromRgb(255, 240, 245));
                titleBarBg = new SolidColorBrush(Color.FromRgb(240, 200, 220));
                textColor = new SolidColorBrush(Color.FromRgb(60, 30, 50));
                mutedText = new SolidColorBrush(Color.FromRgb(120, 80, 100));
                cardBg = new SolidColorBrush(Color.FromRgb(250, 225, 235));
                accentColor = new SolidColorBrush(Color.FromRgb(200, 80, 130));
                break;
            case "PastelBlue":
                bgColor = new SolidColorBrush(Color.FromRgb(235, 245, 255));
                titleBarBg = new SolidColorBrush(Color.FromRgb(200, 220, 245));
                textColor = new SolidColorBrush(Color.FromRgb(40, 50, 70));
                mutedText = new SolidColorBrush(Color.FromRgb(100, 120, 150));
                cardBg = new SolidColorBrush(Color.FromRgb(220, 235, 250));
                accentColor = new SolidColorBrush(Color.FromRgb(80, 140, 200));
                break;
            case "ForestGreen":
                bgColor = new SolidColorBrush(Color.FromRgb(25, 45, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(30, 50, 35));
                textColor = new SolidColorBrush(Color.FromRgb(200, 230, 210));
                mutedText = new SolidColorBrush(Color.FromRgb(120, 160, 130));
                cardBg = new SolidColorBrush(Color.FromRgb(35, 60, 40));
                accentColor = new SolidColorBrush(Color.FromRgb(100, 200, 130));
                break;
            case "AMOLED":
                bgColor = new SolidColorBrush(Color.FromRgb(0, 0, 0));
                titleBarBg = new SolidColorBrush(Color.FromRgb(15, 15, 15));
                textColor = new SolidColorBrush(Color.FromRgb(200, 200, 200));
                mutedText = new SolidColorBrush(Color.FromRgb(100, 100, 100));
                cardBg = new SolidColorBrush(Color.FromRgb(20, 20, 20));
                accentColor = new SolidColorBrush(Color.FromRgb(78, 201, 176));
                break;
            case "Void":
                bgColor = new SolidColorBrush(Color.FromRgb(15, 10, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(20, 15, 40));
                textColor = new SolidColorBrush(Color.FromRgb(180, 170, 220));
                mutedText = new SolidColorBrush(Color.FromRgb(120, 110, 160));
                cardBg = new SolidColorBrush(Color.FromRgb(25, 20, 50));
                accentColor = new SolidColorBrush(Color.FromRgb(160, 100, 220));
                break;
            case "VioletSorrow":
                bgColor = new SolidColorBrush(Color.FromRgb(22, 12, 42));
                titleBarBg = new SolidColorBrush(Color.FromRgb(28, 18, 52));
                textColor = new SolidColorBrush(Color.FromRgb(185, 170, 215));
                mutedText = new SolidColorBrush(Color.FromRgb(130, 115, 165));
                cardBg = new SolidColorBrush(Color.FromRgb(35, 25, 60));
                accentColor = new SolidColorBrush(Color.FromRgb(180, 120, 220));
                break;
            default: // Default dark theme
                bgColor = new SolidColorBrush(Color.FromRgb(30, 30, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(37, 37, 38));
                textColor = new SolidColorBrush(Color.FromRgb(212, 212, 212));
                mutedText = new SolidColorBrush(Color.FromRgb(128, 128, 128));
                cardBg = new SolidColorBrush(Color.FromRgb(45, 45, 48));
                accentColor = new SolidColorBrush(Color.FromRgb(78, 201, 176));
                break;
        }
        
        // Apply colors
        this.Background = bgColor;
        TitleBar.Background = titleBarBg;
        TitleText.Foreground = textColor;
        
        AppNameText.Foreground = textColor;
        SubtitleText.Foreground = mutedText;
        
        VersionBorder.Background = cardBg;
        VersionLabel.Foreground = mutedText;
        VersionText.Foreground = textColor;
        
        CreatorBorder.Background = cardBg;
        CreatorLabel.Foreground = mutedText;
        CreatorText.Foreground = textColor;
        
        SupportBorder.Background = titleBarBg;
        SupportTitle.Foreground = accentColor;
        SupportText.Foreground = textColor;
        ThanksLabel.Foreground = mutedText;
        SupportersList.Foreground = new SolidColorBrush(Color.FromRgb(220, 220, 170)); // Keep gold for names
    }
}
