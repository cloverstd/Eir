package documents

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"golang.org/x/image/draw"
	"image"
	"image/jpeg"

	_ "golang.org/x/image/webp"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var renderSlots = make(chan struct{}, 2)

func acquire(ctx context.Context) error {
	select {
	case renderSlots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var ErrUnavailable = errors.New("文件预览组件暂不可用")

type Info struct {
	MIME  string
	Pages int
	Text  string
}

func command(ctx context.Context, name string, args ...string) error {
	if _, e := exec.LookPath(name); e != nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	if e := cmd.Run(); e != nil {
		return errors.New("无法读取文件，请检查文件格式、密码或内容")
	}
	return nil
}
func Prepare(ctx context.Context, dir string) (Info, error) {
	if e := acquire(ctx); e != nil {
		return Info{}, e
	}
	defer func() { <-renderSlots }()
	p := filepath.Join(dir, "original")
	f, e := os.Open(p)
	if e != nil {
		return Info{}, e
	}
	head := make([]byte, 512)
	n, _ := f.Read(head)
	f.Close()
	head = head[:n]
	info := Info{Pages: 1}
	switch {
	case bytes.HasPrefix(head, []byte("%PDF-")):
		info.MIME = "application/pdf"
		meta := filepath.Join(dir, "info.txt")
		if _, e = exec.LookPath("pdfinfo"); e != nil {
			return info, ErrUnavailable
		}
		metaOut, err := os.Create(meta)
		if err != nil {
			return info, err
		}
		pdfCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cmd := exec.CommandContext(pdfCtx, "pdfinfo", p)
		cmd.Env = append(os.Environ(), "LC_ALL=C")
		cmd.Stdout = metaOut
		err = cmd.Run()
		metaOut.Close()
		cancel()
		if err != nil {
			return info, errors.New("PDF 无法读取或已加密")
		}
		b, _ := os.ReadFile(meta)
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "Pages:") {
				info.Pages, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(l, "Pages:")))
			}
		}
		if info.Pages < 1 || info.Pages > 500 {
			return info, errors.New("PDF 需要 1 至 500 页")
		}
		text := filepath.Join(dir, "text.txt")
		if e = command(ctx, "pdftotext", "-layout", "-enc", "UTF-8", p, text); e != nil {
			return info, e
		}
		f, e = os.Open(text)
		if e != nil {
			return info, e
		}
		b, e = io.ReadAll(io.LimitReader(f, 2<<20))
		f.Close()
		if e != nil {
			return info, e
		}
		info.Text = strings.TrimSpace(strings.ToValidUTF8(string(b), ""))
	case len(head) >= 12 && string(head[4:8]) == "ftyp" && (bytes.Contains(head[:min(len(head), 64)], []byte("heic")) || bytes.Contains(head[:min(len(head), 64)], []byte("heix")) || bytes.Contains(head[:min(len(head), 64)], []byte("mif1"))):
		info.MIME = "image/heic"
		if e = command(ctx, "heif-convert", p, filepath.Join(dir, "preview.png")); e != nil {
			return info, e
		}
	default:
		f, e = os.Open(p)
		if e != nil {
			return info, e
		}
		cfg, format, err := image.DecodeConfig(f)
		f.Close()
		if err != nil || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 40000000 {
			return info, errors.New("仅支持 PDF、JPEG、PNG、WebP、HEIC，图片不能超过 4000 万像素")
		}
		info.MIME = map[string]string{"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[format]
		if info.MIME == "" {
			return info, errors.New("不支持该图片格式")
		}
	}
	if info.MIME != "application/pdf" {
		source := p
		if info.MIME == "image/heic" {
			source = filepath.Join(dir, "preview.png")
		}
		if e = thumbnail(source, filepath.Join(dir, "preview.jpg")); e != nil {
			return info, e
		}
	}
	return info, nil
}
func thumbnail(source, target string) error {
	f, e := os.Open(source)
	if e != nil {
		return e
	}
	cfg, _, e := image.DecodeConfig(f)
	f.Close()
	if e != nil || int64(cfg.Width)*int64(cfg.Height) > 40000000 {
		return errors.New("图片超过预览限制")
	}
	f, e = os.Open(source)
	if e != nil {
		return e
	}
	img, _, e := image.Decode(f)
	f.Close()
	if e != nil {
		return e
	}
	w, h := cfg.Width, cfg.Height
	if w > 1600 || h > 1600 {
		ratio := 1600.0 / float64(max(w, h))
		w = max(1, int(float64(w)*ratio))
		h = max(1, int(float64(h)*ratio))
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Src, nil)
	out, e := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if e != nil {
		return e
	}
	e = jpeg.Encode(out, dst, &jpeg.Options{Quality: 85})
	ce := out.Close()
	if e != nil {
		return e
	}
	return ce
}
func Page(ctx context.Context, dir, mime string, page, pages int) (string, string, error) {
	if e := acquire(ctx); e != nil {
		return "", "", e
	}
	defer func() { <-renderSlots }()
	if page < 1 || page > pages {
		return "", "", errors.New("无效页码")
	}
	if mime != "application/pdf" {
		return filepath.Join(dir, "preview.jpg"), "image/jpeg", nil
	}
	cache := filepath.Join(dir, fmt.Sprintf("page-%d.jpg", page))
	if _, e := os.Stat(cache); e == nil {
		return cache, "image/jpeg", nil
	}
	temp, e := os.MkdirTemp(dir, ".page-")
	if e != nil {
		return "", "", e
	}
	defer os.RemoveAll(temp)
	prefix := filepath.Join(temp, "render")
	if e = command(ctx, "pdftoppm", "-f", strconv.Itoa(page), "-singlefile", "-scale-to", "1600", "-jpeg", "-jpegopt", "quality=85", filepath.Join(dir, "original"), prefix); e != nil {
		return "", "", e
	}
	if e = os.Rename(prefix+".jpg", cache); e != nil {
		return "", "", e
	}
	return cache, "image/jpeg", nil
}
