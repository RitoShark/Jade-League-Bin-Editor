using System;
using System.Windows;
using System.Windows.Input;
using Jade.Core;

namespace Jade.Editor;

/// <summary>
/// Handles keyboard and mouse input for text editing
/// </summary>
public class InputController
{
    private readonly TextBuffer _buffer;
    private readonly TextSelection _selection;
    private int _caretLine;
    private int _caretColumn;

    public int CaretLine => _caretLine;
    public int CaretColumn => _caretColumn;

    public event EventHandler? CaretMoved;
    public event EventHandler? SelectionChanged;

    public InputController(TextBuffer buffer, TextSelection selection)
    {
        _buffer = buffer;
        _selection = selection;
    }

    public void SetCaretPosition(int line, int column, bool extendSelection = false)
    {
        try
        {
            if (_buffer.LineCount == 0)
            {
                Services.Logger.Error("SetCaretPosition: Buffer is empty");
                return;
            }
            
            _caretLine = Math.Clamp(line, 0, _buffer.LineCount - 1);
            var lineText = _buffer.GetLine(_caretLine);
            _caretColumn = Math.Clamp(column, 0, lineText.Length);

            if (!extendSelection)
            {
                _selection.Clear(_caretLine, _caretColumn);
            }
            else
            {
                _selection.EndLine = _caretLine;
                _selection.EndColumn = _caretColumn;
            }

            CaretMoved?.Invoke(this, EventArgs.Empty);
            SelectionChanged?.Invoke(this, EventArgs.Empty);
        }
        catch (Exception ex)
        {
            Services.Logger.Error($"SetCaretPosition failed: line={line}, col={column}", ex);
        }
    }

    public void HandleKeyDown(KeyEventArgs e)
    {
        try
        {
            Services.Logger.Debug($"HandleKeyDown: Key={e.Key}, Modifiers={e.KeyboardDevice.Modifiers}");
            
            var shift = e.KeyboardDevice.Modifiers.HasFlag(ModifierKeys.Shift);
            var ctrl = e.KeyboardDevice.Modifiers.HasFlag(ModifierKeys.Control);

            switch (e.Key)
            {
            case Key.Left:
                MoveLeft(shift, ctrl);
                e.Handled = true;
                break;

            case Key.Right:
                MoveRight(shift, ctrl);
                e.Handled = true;
                break;

            case Key.Up:
                MoveUp(shift);
                e.Handled = true;
                break;

            case Key.Down:
                MoveDown(shift);
                e.Handled = true;
                break;

            case Key.Home:
                MoveHome(shift, ctrl);
                e.Handled = true;
                break;

            case Key.End:
                MoveEnd(shift, ctrl);
                e.Handled = true;
                break;

            case Key.Back:
                HandleBackspace();
                e.Handled = true;
                break;

            case Key.Delete:
                HandleDelete();
                e.Handled = true;
                break;

            case Key.Enter:
                HandleEnter();
                e.Handled = true;
                break;

            case Key.Z when ctrl:
                HandleUndo();
                e.Handled = true;
                break;

            case Key.Y when ctrl:
                HandleRedo();
                e.Handled = true;
                break;

            case Key.C when ctrl:
                HandleCopy();
                e.Handled = true;
                break;

            case Key.X when ctrl:
                HandleCut();
                e.Handled = true;
                break;

            case Key.V when ctrl:
                HandlePaste();
                e.Handled = true;
                break;

            case Key.A when ctrl:
                SelectAll();
                e.Handled = true;
                break;
            }
        }
        catch (Exception ex)
        {
            Services.Logger.Error($"HandleKeyDown failed for key {e.Key}", ex);
        }
    }

    public void HandleTextInput(string text)
    {
        if (_selection.HasSelection)
        {
            DeleteSelection();
        }

        _buffer.InsertText(_caretLine, _caretColumn, text);
        _caretColumn += text.Length;
        _selection.Clear(_caretLine, _caretColumn);

        CaretMoved?.Invoke(this, EventArgs.Empty);
    }

    private void MoveLeft(bool shift, bool ctrl)
    {
        if (_caretColumn > 0)
        {
            _caretColumn--;
        }
        else if (_caretLine > 0)
        {
            _caretLine--;
            _caretColumn = _buffer.GetLine(_caretLine).Length;
        }
        SetCaretPosition(_caretLine, _caretColumn, shift);
    }

    private void MoveRight(bool shift, bool ctrl)
    {
        var lineText = _buffer.GetLine(_caretLine);
        if (_caretColumn < lineText.Length)
        {
            _caretColumn++;
        }
        else if (_caretLine < _buffer.LineCount - 1)
        {
            _caretLine++;
            _caretColumn = 0;
        }
        SetCaretPosition(_caretLine, _caretColumn, shift);
    }

    private void MoveUp(bool shift)
    {
        if (_caretLine > 0)
        {
            SetCaretPosition(_caretLine - 1, _caretColumn, shift);
        }
    }

    private void MoveDown(bool shift)
    {
        if (_caretLine < _buffer.LineCount - 1)
        {
            SetCaretPosition(_caretLine + 1, _caretColumn, shift);
        }
    }

    private void MoveHome(bool shift, bool ctrl)
    {
        if (ctrl)
        {
            SetCaretPosition(0, 0, shift);
        }
        else
        {
            SetCaretPosition(_caretLine, 0, shift);
        }
    }

    private void MoveEnd(bool shift, bool ctrl)
    {
        if (ctrl)
        {
            var lastLine = _buffer.LineCount - 1;
            SetCaretPosition(lastLine, _buffer.GetLine(lastLine).Length, shift);
        }
        else
        {
            SetCaretPosition(_caretLine, _buffer.GetLine(_caretLine).Length, shift);
        }
    }

    private void HandleBackspace()
    {
        if (_selection.HasSelection)
        {
            DeleteSelection();
        }
        else if (_caretColumn > 0)
        {
            _buffer.DeleteText(_caretLine, _caretColumn - 1, _caretLine, _caretColumn);
            _caretColumn--;
            _selection.Clear(_caretLine, _caretColumn);
            CaretMoved?.Invoke(this, EventArgs.Empty);
        }
        else if (_caretLine > 0)
        {
            var prevLineLength = _buffer.GetLine(_caretLine - 1).Length;
            _buffer.DeleteText(_caretLine - 1, prevLineLength, _caretLine, 0);
            _caretLine--;
            _caretColumn = prevLineLength;
            _selection.Clear(_caretLine, _caretColumn);
            CaretMoved?.Invoke(this, EventArgs.Empty);
        }
    }

    private void HandleDelete()
    {
        if (_selection.HasSelection)
        {
            DeleteSelection();
        }
        else
        {
            var lineText = _buffer.GetLine(_caretLine);
            if (_caretColumn < lineText.Length)
            {
                _buffer.DeleteText(_caretLine, _caretColumn, _caretLine, _caretColumn + 1);
            }
            else if (_caretLine < _buffer.LineCount - 1)
            {
                _buffer.DeleteText(_caretLine, _caretColumn, _caretLine + 1, 0);
            }
        }
    }

    private void HandleEnter()
    {
        if (_selection.HasSelection)
        {
            DeleteSelection();
        }

        _buffer.InsertText(_caretLine, _caretColumn, Environment.NewLine);
        _caretLine++;
        _caretColumn = 0;
        _selection.Clear(_caretLine, _caretColumn);
        CaretMoved?.Invoke(this, EventArgs.Empty);
    }

    private void HandleUndo()
    {
        var pos = _buffer.Undo();
        if (pos.line >= 0)
        {
            SetCaretPosition(pos.line, pos.column);
        }
    }

    private void HandleRedo()
    {
        var pos = _buffer.Redo();
        if (pos.line >= 0)
        {
            SetCaretPosition(pos.line, pos.column);
        }
    }

    private void HandleCopy()
    {
        try
        {
            Services.Logger.Debug($"HandleCopy called, HasSelection={_selection.HasSelection}");
            
            if (_selection.HasSelection)
            {
                Services.Logger.Debug($"Selection before normalize: Start=({_selection.StartLine},{_selection.StartColumn}), End=({_selection.EndLine},{_selection.EndColumn})");
                
                _selection.Normalize();
                
                Services.Logger.Debug($"Selection after normalize: Start=({_selection.StartLine},{_selection.StartColumn}), End=({_selection.EndLine},{_selection.EndColumn}), BufferLines={_buffer.LineCount}");
                
                // Validate selection bounds
                if (_selection.StartLine < 0 || _selection.StartLine >= _buffer.LineCount ||
                    _selection.EndLine < 0 || _selection.EndLine >= _buffer.LineCount)
                {
                    Services.Logger.Error($"Invalid selection bounds for copy: Start=({_selection.StartLine},{_selection.StartColumn}), End=({_selection.EndLine},{_selection.EndColumn}), BufferLines={_buffer.LineCount}");
                    return;
                }
                
                Services.Logger.Debug("Getting text range...");
                var text = _buffer.GetTextRange(
                    _selection.StartLine, _selection.StartColumn,
                    _selection.EndLine, _selection.EndColumn);
                
                Services.Logger.Debug($"Got text, length={text?.Length ?? 0}");
                
                if (!string.IsNullOrEmpty(text))
                {
                    Services.Logger.Debug("Setting clipboard...");
                    Clipboard.SetText(text);
                    Services.Logger.Info($"Copied {text.Length} characters");
                }
                else
                {
                    Services.Logger.Debug("Text is empty, not copying");
                }
            }
            else
            {
                Services.Logger.Debug("No selection, nothing to copy");
            }
        }
        catch (Exception ex)
        {
            Services.Logger.Error("Failed to copy text", ex);
            // Don't rethrow - just log and continue
        }
    }

    private void HandleCut()
    {
        try
        {
            if (_selection.HasSelection)
            {
                HandleCopy();
                DeleteSelection();
            }
        }
        catch (Exception ex)
        {
            Services.Logger.Error("Failed to cut text", ex);
        }
    }

    private void HandlePaste()
    {
        try
        {
            if (Clipboard.ContainsText())
            {
                var text = Clipboard.GetText();
                if (_selection.HasSelection)
                {
                    DeleteSelection();
                }
                _buffer.InsertText(_caretLine, _caretColumn, text);
                
                var lines = text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
                if (lines.Length == 1)
                {
                    _caretColumn += text.Length;
                }
                else
                {
                    _caretLine += lines.Length - 1;
                    _caretColumn = lines[^1].Length;
                }
                
                _selection.Clear(_caretLine, _caretColumn);
                CaretMoved?.Invoke(this, EventArgs.Empty);
            }
        }
        catch (Exception ex)
        {
            Services.Logger.Error("Failed to paste text", ex);
        }
    }

    private void SelectAll()
    {
        _selection.StartLine = 0;
        _selection.StartColumn = 0;
        _selection.EndLine = _buffer.LineCount - 1;
        _selection.EndColumn = _buffer.GetLine(_selection.EndLine).Length;
        
        _caretLine = _selection.EndLine;
        _caretColumn = _selection.EndColumn;
        
        SelectionChanged?.Invoke(this, EventArgs.Empty);
        CaretMoved?.Invoke(this, EventArgs.Empty);
    }

    private void DeleteSelection()
    {
        _selection.Normalize();
        _buffer.DeleteText(
            _selection.StartLine, _selection.StartColumn,
            _selection.EndLine, _selection.EndColumn);
        
        _caretLine = _selection.StartLine;
        _caretColumn = _selection.StartColumn;
        _selection.Clear(_caretLine, _caretColumn);
        
        CaretMoved?.Invoke(this, EventArgs.Empty);
        SelectionChanged?.Invoke(this, EventArgs.Empty);
    }
}
