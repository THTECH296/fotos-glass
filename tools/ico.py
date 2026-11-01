# Refaz src-tauri/icons/icon.ico com os tamanhos pequenos em bitmap (não PNG).
# O `tauri icon` grava todos os tamanhos em PNG, e partes do Windows (cabeçalho dos avisos,
# busca do Menu Iniciar) não leem PNG em 16/24 px e mostram um ícone genérico.
from PIL import Image
im = Image.open('src-tauri/icons/icon.png').convert('RGBA')
im.save('src-tauri/icons/icon.ico', format='ICO', bitmap_format='bmp',
        sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (96, 96), (128, 128), (256, 256)])
print('icon.ico refeito')
