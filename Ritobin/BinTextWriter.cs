using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;

namespace Jade.Ritobin;

public class BinTextWriter
{
    private readonly List<char> _buffer;
    private int _indent = 0;
    private const int IndentSize = 4;
    private const int MaxIndent = 256;
    private static readonly char[] _paddingBuffer = new string(' ', MaxIndent).ToCharArray();
    
    // Cache common strings to avoid allocations
    private static readonly string[] _typeNames = new string[256];
    
    static BinTextWriter()
    {
        _typeNames[(int)BinType.None] = "none";
        _typeNames[(int)BinType.Bool] = "bool";
        _typeNames[(int)BinType.I8] = "i8";
        _typeNames[(int)BinType.U8] = "u8";
        _typeNames[(int)BinType.I16] = "i16";
        _typeNames[(int)BinType.U16] = "u16";
        _typeNames[(int)BinType.I32] = "i32";
        _typeNames[(int)BinType.U32] = "u32";
        _typeNames[(int)BinType.I64] = "i64";
        _typeNames[(int)BinType.U64] = "u64";
        _typeNames[(int)BinType.F32] = "f32";
        _typeNames[(int)BinType.Vec2] = "vec2";
        _typeNames[(int)BinType.Vec3] = "vec3";
        _typeNames[(int)BinType.Vec4] = "vec4";
        _typeNames[(int)BinType.Mtx44] = "mtx44";
        _typeNames[(int)BinType.Rgba] = "rgba";
        _typeNames[(int)BinType.String] = "string";
        _typeNames[(int)BinType.Hash] = "hash";
        _typeNames[(int)BinType.File] = "file";
        _typeNames[(int)BinType.Link] = "link";
        _typeNames[(int)BinType.Flag] = "flag";
        _typeNames[(int)BinType.Pointer] = "pointer";
        _typeNames[(int)BinType.Embed] = "embed";
    }

    public BinTextWriter()
    {
        // Pre-allocate reasonable capacity
        _buffer = new List<char>(65536);
    }

    public string Write(Bin bin)
    {
        _buffer.Clear();
        WriteRaw("#PROP_text\n");
        
        foreach (var section in bin.Sections)
        {
            WriteSection(section.Key, section.Value);
        }
        
        return new string(_buffer.ToArray());
    }

    private void WriteSection(string name, BinValue value)
    {
        WriteRaw(name);
        WriteRaw(": ");
        WriteType(value);
        WriteRaw(" = ");
        WriteValue(value);
        WriteRaw("\n");
    }

    private void WriteType(BinValue value)
    {
        switch (value)
        {
            case BinList l:
                WriteRaw("list[");
                WriteRaw(GetTypeString(l.ValueType));
                WriteRaw("]");
                break;
            case BinList2 l2:
                WriteRaw("list2[");
                WriteRaw(GetTypeString(l2.ValueType));
                WriteRaw("]");
                break;
            case BinOption o:
                WriteRaw("option[");
                WriteRaw(GetTypeString(o.ValueType));
                WriteRaw("]");
                break;
            case BinMap m:
                WriteRaw("map[");
                WriteRaw(GetTypeString(m.KeyType));
                WriteRaw(",");
                WriteRaw(GetTypeString(m.ValueType));
                WriteRaw("]");
                break;
            default:
                WriteRaw(GetTypeString(value.Type));
                break;
        }
    }

    private string GetTypeString(BinType type)
    {
        return _typeNames[(int)type] ?? throw new Exception($"Unknown type: {type}");
    }

    private void WriteValue(BinValue value)
    {
        switch (value)
        {
            case BinNone: WriteRaw("null"); break;
            case BinBool b: WriteRaw(b.Value ? "true" : "false"); break;
            case BinI8 i8: WriteNumber(i8.Value); break;
            case BinU8 u8: WriteNumber(u8.Value); break;
            case BinI16 i16: WriteNumber(i16.Value); break;
            case BinU16 u16: WriteNumber(u16.Value); break;
            case BinI32 i32: WriteNumber(i32.Value); break;
            case BinU32 u32: WriteNumber(u32.Value); break;
            case BinI64 i64: WriteNumber(i64.Value); break;
            case BinU64 u64: WriteNumber(u64.Value); break;
            case BinF32 f32: WriteFloat(f32.Value); break;
            case BinVec2 v2: WriteVec2(v2.Value); break;
            case BinVec3 v3: WriteVec3(v3.Value); break;
            case BinVec4 v4: WriteVec4(v4.Value); break;
            case BinMtx44 m: WriteMtx44(m.Value); break;
            case BinRgba c: WriteRgba(c); break;
            case BinString s: WriteString(s.Value); break;
            case BinHash h: WriteHashValue(h.Value); break;
            case BinFile f: WriteHashValue(f.Value); break;
            case BinLink l: WriteHashValue(l.Value); break;
            case BinFlag fl: WriteRaw(fl.Value ? "true" : "false"); break;
            
            case BinList l: WriteList(l.Items); break;
            case BinList2 l2: WriteList(l2.Items); break;
            case BinOption o: WriteList(o.Items); break;
            case BinMap m: WriteMap(m.Items); break;
            
            case BinPointer p:
                if (p.Name.Hash == 0 && string.IsNullOrEmpty(p.Name.String))
                {
                    WriteRaw("null");
                }
                else
                {
                    WriteHashName(p.Name);
                    WriteRaw(" ");
                    WriteFields(p.Items);
                }
                break;
                
            case BinEmbed e:
                WriteHashName(e.Name);
                WriteRaw(" ");
                WriteFields(e.Items);
                break;
        }
    }

    private void WriteList(List<BinValue> items)
    {
        if (items.Count == 0)
        {
            WriteRaw("{}");
            return;
        }

        WriteRaw("{\n");
        _indent += IndentSize;
        foreach (var item in items)
        {
            WritePadding();
            WriteValue(item);
            WriteRaw("\n");
        }
        _indent -= IndentSize;
        WritePadding();
        WriteRaw("}");
    }

    private void WriteMap(List<KeyValuePair<BinValue, BinValue>> items)
    {
        if (items.Count == 0)
        {
            WriteRaw("{}");
            return;
        }

        WriteRaw("{\n");
        _indent += IndentSize;
        foreach (var kvp in items)
        {
            WritePadding();
            WriteValue(kvp.Key);
            WriteRaw(" = ");
            WriteValue(kvp.Value);
            WriteRaw("\n");
        }
        _indent -= IndentSize;
        WritePadding();
        WriteRaw("}");
    }

    private void WriteFields(List<BinField> fields)
    {
        if (fields.Count == 0)
        {
            WriteRaw("{}");
            return;
        }

        WriteRaw("{\n");
        _indent += IndentSize;
        foreach (var field in fields)
        {
            WritePadding();
            WriteHashName(field.Key);
            WriteRaw(": ");
            WriteType(field.Value);
            WriteRaw(" = ");
            WriteValue(field.Value);
            WriteRaw("\n");
        }
        _indent -= IndentSize;
        WritePadding();
        WriteRaw("}");
    }

    private void WriteVec2(Vector2 v)
    {
        WriteRaw("{ ");
        WriteFloat(v.X);
        WriteRaw(", ");
        WriteFloat(v.Y);
        WriteRaw(" }");
    }

    private void WriteVec3(Vector3 v)
    {
        WriteRaw("{ ");
        WriteFloat(v.X);
        WriteRaw(", ");
        WriteFloat(v.Y);
        WriteRaw(", ");
        WriteFloat(v.Z);
        WriteRaw(" }");
    }

    private void WriteVec4(Vector4 v)
    {
        WriteRaw("{ ");
        WriteFloat(v.X);
        WriteRaw(", ");
        WriteFloat(v.Y);
        WriteRaw(", ");
        WriteFloat(v.Z);
        WriteRaw(", ");
        WriteFloat(v.W);
        WriteRaw(" }");
    }

    private void WriteMtx44(Matrix4x4 m)
    {
        WriteRaw("{\n");
        _indent += IndentSize;
        
        WritePadding();
        WriteFloat(m.M11); WriteRaw(", "); WriteFloat(m.M12); WriteRaw(", "); WriteFloat(m.M13); WriteRaw(", "); WriteFloat(m.M14);
        WriteRaw("\n");
        
        WritePadding();
        WriteFloat(m.M21); WriteRaw(", "); WriteFloat(m.M22); WriteRaw(", "); WriteFloat(m.M23); WriteRaw(", "); WriteFloat(m.M24);
        WriteRaw("\n");
        
        WritePadding();
        WriteFloat(m.M31); WriteRaw(", "); WriteFloat(m.M32); WriteRaw(", "); WriteFloat(m.M33); WriteRaw(", "); WriteFloat(m.M34);
        WriteRaw("\n");
        
        WritePadding();
        WriteFloat(m.M41); WriteRaw(", "); WriteFloat(m.M42); WriteRaw(", "); WriteFloat(m.M43); WriteRaw(", "); WriteFloat(m.M44);
        WriteRaw("\n");
        
        _indent -= IndentSize;
        WritePadding();
        WriteRaw("}");
    }

    private void WriteRgba(BinRgba c)
    {
        WriteRaw("{ ");
        WriteNumber(c.R);
        WriteRaw(", ");
        WriteNumber(c.G);
        WriteRaw(", ");
        WriteNumber(c.B);
        WriteRaw(", ");
        WriteNumber(c.A);
        WriteRaw(" }");
    }

    private void WriteHashValue(FNV1a hash)
    {
        if (!string.IsNullOrEmpty(hash.String))
        {
            WriteRaw("\"");
            WriteRaw(hash.String);
            WriteRaw("\"");
        }
        else
        {
            WriteHex(hash.Hash);
        }
    }

    private void WriteHashValue(XXH64 hash)
    {
        if (!string.IsNullOrEmpty(hash.String))
        {
            WriteRaw("\"");
            WriteRaw(hash.String);
            WriteRaw("\"");
        }
        else
        {
            WriteHex64(hash.Hash);
        }
    }

    private void WriteHashName(FNV1a hash)
    {
        if (!string.IsNullOrEmpty(hash.String))
        {
            WriteRaw(hash.String);
        }
        else
        {
            WriteHex(hash.Hash);
        }
    }

    private void WriteString(string s)
    {
        WriteRaw("\"");
        // TODO: Escape special characters if needed
        WriteRaw(s);
        WriteRaw("\"");
    }

    private void WriteNumber<T>(T value) where T : struct
    {
        WriteRaw(value.ToString()!);
    }

    private void WriteFloat(float value)
    {
        WriteRaw(value.ToString(CultureInfo.InvariantCulture));
    }

    private void WriteHex(uint value)
    {
        Span<char> buffer = stackalloc char[10];
        buffer[0] = '0';
        buffer[1] = 'x';
        
        const string digits = "0123456789abcdef";
        for (int i = 9; i >= 2; i--)
        {
            buffer[i] = digits[(int)(value & 0xF)];
            value >>= 4;
        }
        
        WriteRaw(buffer);
    }

    private void WriteHex64(ulong value)
    {
        Span<char> buffer = stackalloc char[18];
        buffer[0] = '0';
        buffer[1] = 'x';
        
        const string digits = "0123456789abcdef";
        for (int i = 17; i >= 2; i--)
        {
            buffer[i] = digits[(int)(value & 0xF)];
            value >>= 4;
        }
        
        WriteRaw(buffer);
    }

    private void WritePadding()
    {
        if (_indent > 0)
        {
            _buffer.AddRange(new ReadOnlySpan<char>(_paddingBuffer, 0, _indent));
        }
    }

    private void WriteRaw(string str)
    {
        _buffer.AddRange(str);
    }

    private void WriteRaw(ReadOnlySpan<char> span)
    {
        foreach (var c in span)
        {
            _buffer.Add(c);
        }
    }
}
