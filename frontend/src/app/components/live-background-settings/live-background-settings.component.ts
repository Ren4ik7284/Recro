import { Component, inject, ViewEncapsulation, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LiveBackgroundService, SavedMediaItem } from '../../services/live-background.service';
import { I18nService } from '../../services/i18n.service';

@Component({
  selector: 'app-live-background-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './live-background-settings.component.html',
  styleUrl: './live-background-settings.component.scss',
  encapsulation: ViewEncapsulation.None,
})
export class LiveBackgroundSettingsComponent {
  readonly bgService = inject(LiveBackgroundService);
  readonly i18n = inject(I18nService);

  readonly urlInput = signal<string>('');

  async onApplyUrl() {
    const url = this.urlInput().trim();
    if (!url) return;
    const ok = await this.bgService.resolveAndApplyUrl(url);
    if (ok) {
      this.urlInput.set('');
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.bgService.handleFileUpload(input.files[0]);
    }
  }

  onDropFile(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer?.files && event.dataTransfer.files[0]) {
      this.bgService.handleFileUpload(event.dataTransfer.files[0]);
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
  }

  selectSaved(item: SavedMediaItem) {
    this.bgService.selectSavedItem(item);
  }

  removeSaved(item: SavedMediaItem, event: Event) {
    event.stopPropagation();
    this.bgService.removeSavedItem(item.id);
  }
}
