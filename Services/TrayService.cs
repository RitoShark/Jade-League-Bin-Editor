using System;
using System.Drawing;
using System.Windows.Forms;
using System.Windows;
using Application = System.Windows.Application;

namespace Jade.Services;

public static class TrayService
{
    private static NotifyIcon? _notifyIcon;
    private static bool _isInitialized;

    public static void Initialize()
    {
        if (_isInitialized) return;

        try
        {
            _notifyIcon = new NotifyIcon();
            
            // Try to load icon from resources
            var iconStream = Application.GetResourceStream(new Uri("pack://application:,,,/Jade;component/jade.ico"))?.Stream;
            if (iconStream != null)
            {
                _notifyIcon.Icon = new Icon(iconStream);
            }
            
            _notifyIcon.Text = "Jade BIN Editor";
            _notifyIcon.Visible = false;

            var contextMenu = new ContextMenuStrip();
            contextMenu.Items.Add("Show Jade", null, (s, e) => ShowMainWindow());
            contextMenu.Items.Add("-");
            contextMenu.Items.Add("Exit", null, (s, e) => ExitApplication());

            _notifyIcon.ContextMenuStrip = contextMenu;
            _notifyIcon.DoubleClick += (s, e) => ShowMainWindow();

            _isInitialized = true;
            Logger.Info("Tray service initialized successfully");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to initialize Tray service", ex);
        }
    }

    public static void SetVisible(bool visible)
    {
        if (_notifyIcon != null)
        {
            _notifyIcon.Visible = visible;
        }
    }

    public static void ShowMainWindow()
    {
        Application.Current.Dispatcher.Invoke(() =>
        {
            var mainWindow = Application.Current.MainWindow as Windows.MainWindow;
            if (mainWindow != null)
            {
                mainWindow.Show();
                if (mainWindow.WindowState == WindowState.Minimized)
                {
                    mainWindow.WindowState = WindowState.Normal;
                }
                mainWindow.Activate();
                mainWindow.Focus();
                SetVisible(false); // Hide tray icon when window is visible
            }
        });
    }

    private static void ExitApplication()
    {
        SetVisible(false);
        _notifyIcon?.Dispose();
        Application.Current.Shutdown();
    }

    public static void Cleanup()
    {
        if (_notifyIcon != null)
        {
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
        }
    }
}
