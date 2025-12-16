using System;
using System.Collections.Generic;
using System.Text;
using Jade.Services;

namespace Jade.Core;

/// <summary>
/// Core text buffer managing document content as lines
/// </summary>
public class TextBuffer
{
    private List<string> _lines;
    private Stack<BufferAction> _undoStack;
    private Stack<BufferAction> _redoStack;

    public int LineCount => _lines.Count;
    public event EventHandler? ContentChanged;

    public TextBuffer()
    {
        _lines = new List<string> { "" };
        _undoStack = new Stack<BufferAction>();
        _redoStack = new Stack<BufferAction>();
    }

    public string GetLine(int lineIndex)
    {
        if (lineIndex < 0 || lineIndex >= _lines.Count)
            return "";
        return _lines[lineIndex];
    }

    public string GetText()
    {
        return string.Join(Environment.NewLine, _lines);
    }

    public void SetText(string text)
    {
        var startTime = DateTime.Now;
        Logger.Debug($"SetText called with {text?.Length ?? 0} characters");
        
        _lines.Clear();
        _undoStack.Clear();
        _redoStack.Clear();

        if (string.IsNullOrEmpty(text))
        {
            _lines.Add("");
        }
        else
        {
            var splitStart = DateTime.Now;
            var lines = text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
            var splitTime = (DateTime.Now - splitStart).TotalMilliseconds;
            Logger.Debug($"Split into {lines.Length} lines in {splitTime:F0}ms");
            
            _lines.AddRange(lines);
        }

        var elapsed = (DateTime.Now - startTime).TotalMilliseconds;
        Logger.Info($"SetText completed in {elapsed:F0}ms, {_lines.Count} lines");
        
        ContentChanged?.Invoke(this, EventArgs.Empty);
    }

    public void InsertText(int line, int column, string text, bool recordUndo = true)
    {
        if (line < 0 || line >= _lines.Count) return;

        column = Math.Clamp(column, 0, _lines[line].Length);

        if (recordUndo)
        {
            _redoStack.Clear();
            _undoStack.Push(new BufferAction
            {
                Type = ActionType.Insert,
                Line = line,
                Column = column,
                Text = text
            });
        }

        if (text.Contains('\n') || text.Contains('\r'))
        {
            var insertLines = text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
            var currentLine = _lines[line];
            var before = currentLine.Substring(0, column);
            var after = currentLine.Substring(column);

            _lines[line] = before + insertLines[0];

            for (int i = 1; i < insertLines.Length; i++)
            {
                _lines.Insert(line + i, insertLines[i]);
            }

            var lastLineIndex = line + insertLines.Length - 1;
            _lines[lastLineIndex] += after;
        }
        else
        {
            _lines[line] = _lines[line].Insert(column, text);
        }

        ContentChanged?.Invoke(this, EventArgs.Empty);
    }

    public void DeleteText(int startLine, int startColumn, int endLine, int endColumn, bool recordUndo = true)
    {
        if (startLine < 0 || startLine >= _lines.Count) return;
        if (endLine < 0 || endLine >= _lines.Count) return;

        startColumn = Math.Clamp(startColumn, 0, _lines[startLine].Length);
        endColumn = Math.Clamp(endColumn, 0, _lines[endLine].Length);

        if (startLine == endLine && startColumn == endColumn) return;

        var deletedText = GetTextRange(startLine, startColumn, endLine, endColumn);

        if (recordUndo)
        {
            _redoStack.Clear();
            _undoStack.Push(new BufferAction
            {
                Type = ActionType.Delete,
                Line = startLine,
                Column = startColumn,
                Text = deletedText
            });
        }

        if (startLine == endLine)
        {
            var line = _lines[startLine];
            _lines[startLine] = line.Remove(startColumn, endColumn - startColumn);
        }
        else
        {
            var firstLine = _lines[startLine].Substring(0, startColumn);
            var lastLine = _lines[endLine].Substring(endColumn);
            _lines[startLine] = firstLine + lastLine;

            for (int i = endLine; i > startLine; i--)
            {
                _lines.RemoveAt(i);
            }
        }

        ContentChanged?.Invoke(this, EventArgs.Empty);
    }

    public string GetTextRange(int startLine, int startColumn, int endLine, int endColumn)
    {
        try
        {
            // Validate bounds
            if (startLine < 0 || startLine >= _lines.Count || endLine < 0 || endLine >= _lines.Count)
            {
                Services.Logger.Error($"GetTextRange: Invalid line range {startLine}-{endLine}, count={_lines.Count}");
                return "";
            }
            
            // Clamp columns
            startColumn = Math.Max(0, Math.Min(startColumn, _lines[startLine].Length));
            endColumn = Math.Max(0, Math.Min(endColumn, _lines[endLine].Length));
            
            if (startLine == endLine)
            {
                if (startColumn > endColumn)
                {
                    return "";
                }
                return _lines[startLine].Substring(startColumn, endColumn - startColumn);
            }

            var sb = new StringBuilder();
            sb.Append(_lines[startLine].Substring(startColumn));
            sb.Append(Environment.NewLine);

            for (int i = startLine + 1; i < endLine; i++)
            {
                sb.Append(_lines[i]);
                sb.Append(Environment.NewLine);
            }

            sb.Append(_lines[endLine].Substring(0, endColumn));
            return sb.ToString();
        }
        catch (Exception ex)
        {
            Services.Logger.Error($"GetTextRange failed: {startLine},{startColumn} to {endLine},{endColumn}", ex);
            return "";
        }
    }

    public bool CanUndo => _undoStack.Count > 0;
    public bool CanRedo => _redoStack.Count > 0;

    public (int line, int column) Undo()
    {
        if (!CanUndo) return (-1, -1);

        var action = _undoStack.Pop();
        _redoStack.Push(action);

        if (action.Type == ActionType.Insert)
        {
            var endPos = CalculateEndPosition(action.Line, action.Column, action.Text);
            DeleteText(action.Line, action.Column, endPos.line, endPos.column, false);
            return (action.Line, action.Column);
        }
        else
        {
            InsertText(action.Line, action.Column, action.Text, false);
            var endPos = CalculateEndPosition(action.Line, action.Column, action.Text);
            return endPos;
        }
    }

    public (int line, int column) Redo()
    {
        if (!CanRedo) return (-1, -1);

        var action = _redoStack.Pop();
        _undoStack.Push(action);

        if (action.Type == ActionType.Insert)
        {
            InsertText(action.Line, action.Column, action.Text, false);
            return CalculateEndPosition(action.Line, action.Column, action.Text);
        }
        else
        {
            var endPos = CalculateEndPosition(action.Line, action.Column, action.Text);
            DeleteText(action.Line, action.Column, endPos.line, endPos.column, false);
            return (action.Line, action.Column);
        }
    }

    private (int line, int column) CalculateEndPosition(int startLine, int startColumn, string text)
    {
        var lines = text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
        if (lines.Length == 1)
        {
            return (startLine, startColumn + text.Length);
        }
        return (startLine + lines.Length - 1, lines[^1].Length);
    }

    private enum ActionType { Insert, Delete }

    private class BufferAction
    {
        public ActionType Type { get; set; }
        public int Line { get; set; }
        public int Column { get; set; }
        public string Text { get; set; } = "";
    }
}
