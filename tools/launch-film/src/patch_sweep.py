path = r'D:\document\development\aigc-studio\tools\launch-film\src\transitions.tsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

c = c.replace(
    "label = '\u7b97\u529b\u514d\u8d39\uff0c\u8fd9\u662f\u5168\u90e8\u529f\u80fd'",
    "label = ''",
    1
)

# 文字为空时不渲染文字层
old_text_layer = """      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: textIn * textOut,
        pointerEvents: 'none',
      }}>
        <span style={{ fontFamily: FONT, fontSize: 64, fontWeight: 800, color: '#fff', letterSpacing: -1 }}>
          {label}
        </span>
      </div>
    </AbsoluteFill>
  );
};

/** wipe-transitions"""

new_text_layer = """      {label && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: textIn * textOut,
          pointerEvents: 'none',
        }}>
          <span style={{ fontFamily: FONT, fontSize: 64, fontWeight: 800, color: '#fff', letterSpacing: -1 }}>
            {label}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

/** wipe-transitions"""

c = c.replace(old_text_layer, new_text_layer, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('sweep label cleared')
